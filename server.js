const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 3000;

app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({ storage });

// Analyze MKV file to extract all streams
function analyzeStreams(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);

      const streams = {
        video: [],
        audio: [],
        subtitle: [],
      };

      metadata.streams.forEach((stream, index) => {
        console.log(`Stream ${index}: ${stream.codec_type} - ${stream.codec_name}`);
        if (stream.codec_type === 'video') streams.video.push(index);
        if (stream.codec_type === 'audio') streams.audio.push(index);
        if (stream.codec_type === 'subtitle') streams.subtitle.push(index);
      });

      resolve(streams);
    });
  });
}

function isAudioStreamAAC(filePath, streamIndex) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);

      const stream = metadata.streams.find((s, idx) => s.codec_type === 'audio' && idx === streamIndex);
      if (!stream) return resolve(false);

      const codec = stream.codec_name;
      resolve(codec === 'aac');
    });
  });
}

// Create HLS output for each stream
async function createHLSForStreams(filePath, fileName, streams) {
  const outputPath = path.join(outputDir, fileName);
  fs.mkdirSync(outputPath, { recursive: true });

    const playlistEntries = [];
    const audioEntries = [];
    const subtitleEntries = [];

  // Video streams
  for (let i = 0; i < streams.video.length; i++) {
    const streamIndex = streams.video[i];
    const output = `${outputPath}/video_${i}.m3u8`;
    
    const streamInfo = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata.streams[streamIndex]);
      });
    });
    const isH264 = streamInfo.codec_name === 'h264';

    await new Promise((resolve, reject) => {
       ffmpeg(filePath)
        .addOption('-map', `0:${streamIndex}`)
        .addOption('-f', 'hls')
        .addOption('-hls_time', '10')
        .addOption('-hls_list_size', '0')
        .addOption('-hls_segment_filename', `${outputPath}/video_${i}_%03d.ts`)
        .addOption('-c:v', isH264 ? 'copy' : 'libx264')
        .output(output)
        .on('end', () => {
          playlistEntries.push(`#EXT-X-STREAM-INF:BANDWIDTH=4000000,AUDIO="audios",SUBTITLES="subs"\nvideo_${i}.m3u8`);
          resolve();
        })
        .on('error', reject)
        .run();
    });
  }

  

// Audio streams
for (let i = 0; i < streams.audio.length; i++) {
  const streamIndex = streams.audio[i];
  const output = `${outputPath}/audio_${i}.m3u8`;
  const isAAC = await isAudioStreamAAC(filePath, streamIndex);
  const streamInfo = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.streams[streamIndex]);
    });
  });

  const lang = streamInfo?.tags?.language || `und`;
  await new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .addOption('-map', `0:${streamIndex}`)
        .addOption('-c:a', isAAC ? 'copy' : 'aac')
        .addOption('-f', 'hls')
        .addOption('-hls_time', '10')
        .addOption('-hls_list_size', '0')
        .addOption('-hls_segment_filename', `${outputPath}/audio_${i}_%03d.ts`)
        .output(output)
        .on('end', () => {
          audioEntries.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="${lang}",NAME="${lang}",AUTOSELECT=YES,DEFAULT=${i === 0 ? 'YES' : 'NO'},URI="audio_${i}.m3u8"`);
          resolve();
        })
        .on('error', reject)
        .run();
    });
  }

  // Subtitle streams
  for (let i = 0; i < streams.subtitle.length; i++) {
    const streamIndex = streams.subtitle[i];
    const vttOutput = `${outputPath}/sub_${i}.vtt`;
    const m3u8Output = `${outputPath}/sub_${i}.m3u8`;
    const streamInfo = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata.streams[streamIndex]);
        });
    });
  
    if(streamInfo.codec_name === 'hdmv_pgs_subtitle' || streamInfo.codec_name === 'subrip') {
      console.log(`Skipping unsupported subtitle codec: ${streamInfo.codec_name}`);
      continue;
    }

  const lang = streamInfo?.tags?.language || `und`;
  await new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .outputOptions('-map', `0:${streamIndex}`, '-f', 'webvtt')
      .output(vttOutput)
      .on('end', () => {
        // Create a dummy m3u8 file pointing to the single .vtt file
        const m3u8Content = `#EXTM3U
        WEBVTT
        #EXTINF:-1,
        sub_${i}.vtt`;

        fs.writeFileSync(m3u8Output, m3u8Content);

        // Add to subtitle entries for master playlist
        subtitleEntries.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${lang}",NAME="${lang}",AUTOSELECT=YES,DEFAULT=${i === 0 ? 'YES' : 'NO'},URI="sub_${i}.m3u8"`);

        resolve();
      })
      .on('error', reject)
      .run();
  });
  }

  // Create a basic master playlist for video streams
    const masterPlaylist = [
    ...audioEntries,
    ...subtitleEntries,
    ...playlistEntries,
    ].join('\n');

  fs.writeFileSync(`${outputPath}/master.m3u8`, masterPlaylist);

  return `${fileName}/master.m3u8`;
}

app.post('/upload', upload.single('video'), async (req, res) => {
  const filePath = req.file.path;
  const fileName = path.parse(req.file.filename).name;

  try {
    const streams = await analyzeStreams(filePath);
    const streamUrl = await createHLSForStreams(filePath, fileName, streams);

    res.json({
      message: 'Video processed with all streams.',
      streamUrl: `/streams/${streamUrl}`,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Error processing video.');
  }
});

app.use('/streams', express.static(outputDir));

app.get('/', (req, res) => {
  res.send(`
    <h2>Upload MKV File</h2>
    <form method="POST" enctype="multipart/form-data" action="/upload">
      <input type="file" name="video" />
      <button type="submit">Upload</button>
    </form>
  `);
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

const fsPromises = require('fs/promises');

app.get('/videos', async (req, res) => {
  try {
    const dirs = await fsPromises.readdir(outputDir, { withFileTypes: true });
    const videos = [];
    for (const dirent of dirs) {
      if (dirent.isDirectory()) {
        const mp = path.join(outputDir, dirent.name, 'master.m3u8');
        if (fs.existsSync(mp)) {
          videos.push({ name: dirent.name, url: `/streams/${dirent.name}/master.m3u8` });
        }
      }
    }
    res.json(videos);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error listing videos');
  }
});