const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const videoDuration = require('get-video-duration').getVideoDurationInSeconds;

// Configuration
const TERMUX_STORAGE = '/storage/emulated/0';
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATHS = [
  path.join(__dirname, 'token.json'),
  path.join(__dirname, 'token.txt')
];
const METADATA_PATH = path.join(__dirname, 'details.txt');
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv'];
const MAX_PARALLEL_UPLOADS = 3;

// Default metadata
const DEFAULT_METADATA = {
  title: '🔥 Amazing Short #shorts',
  description: 'Check out this Short!\n#shorts #shortvideo #trending',
  tags: ['shorts', 'shortvideo', 'viral'],
  category: '22',
  privacy: 'public',
  madeForKids: false
};

/**
 * Parse metadata from details.txt file
 */
function parseMetadata(videoFile) {
  try {
    const metadata = { ...DEFAULT_METADATA };
    
    // Try to find matching metadata file
    const baseName = path.basename(videoFile, path.extname(videoFile));
    const metadataFiles = [
      METADATA_PATH,
      path.join(path.dirname(videoFile), 'details.txt'),
      path.join(path.dirname(videoFile), `${baseName}.txt`)
    ];

    for (const file of metadataFiles) {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n').filter(line => line.trim() !== '');
        
        lines.forEach(line => {
          const [key, ...valueParts] = line.split(':').map(part => part.trim());
          const value = valueParts.join(':').trim();
          
          switch (key.toLowerCase()) {
            case 'title':
              metadata.title = value;
              break;
            case 'description':
              metadata.description = value;
              break;
            case 'tags':
              metadata.tags = value.split(',').map(tag => tag.trim());
              break;
            case 'category':
              metadata.category = value;
              break;
            case 'privacy':
              metadata.privacy = value.toLowerCase();
              break;
            case 'made for kids':
              metadata.madeForKids = value.toLowerCase() === 'true';
              break;
          }
        });
        break;
      }
    }

    // Ensure #shorts is in title
    if (!metadata.title.includes('#shorts') && !metadata.title.includes('#short')) {
      metadata.title += ' #shorts';
    }

    return metadata;
  } catch (err) {
    console.error('Error reading metadata:', err.message);
    return DEFAULT_METADATA;
  }
}

/**
 * Validate video meets YouTube Shorts requirements
 */
async function validateShorts(videoPath) {
  try {
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video file not found at ${videoPath}`);
    }

    const duration = await videoDuration(videoPath);
    if (duration > 60) {
      throw new Error(`Video is ${duration}s long (Shorts must be ≤60s)`);
    }

    return true;
  } catch (err) {
    console.error('Shorts validation failed:', err.message);
    throw err;
  }
}

/**
 * Upload a single video
 */
async function uploadVideo(auth, videoPath, metadata) {
  const youtube = google.youtube({ version: 'v3', auth });
  const fileSize = fs.statSync(videoPath).size;
  const videoStream = fs.createReadStream(videoPath);
  const baseName = path.basename(videoPath);

  return new Promise((resolve, reject) => {
    youtube.videos.insert(
      {
        part: 'snippet,status',
        requestBody: {
          snippet: {
            title: metadata.title,
            description: metadata.description,
            tags: metadata.tags,
            categoryId: metadata.category,
          },
          status: {
            privacyStatus: metadata.privacy,
            selfDeclaredMadeForKids: metadata.madeForKids,
          },
        },
        media: {
          body: videoStream,
        },
      },
      {
        onUploadProgress: (evt) => {
          const progress = (evt.bytesRead / fileSize) * 100;
          process.stdout.clearLine();
          process.stdout.cursorTo(0);
          process.stdout.write(`Uploading ${baseName}: ${Math.round(progress)}%`);
        },
      },
      (err, response) => {
        if (err) {
          reject(err);
        } else {
          process.stdout.clearLine();
          process.stdout.cursorTo(0);
          console.log(`✅ ${baseName} uploaded successfully! (ID: ${response.data.id})`);
          resolve(response.data);
        }
      }
    );
  });
}

/**
 * Process bulk upload of multiple videos
 */
async function bulkUpload(videoPaths) {
  try {
    console.log(`\nStarting bulk upload of ${videoPaths.length} videos...`);
    
    // Authorize once for all uploads
    const auth = await authorize();
    
    // Process videos in batches
    for (let i = 0; i < videoPaths.length; i += MAX_PARALLEL_UPLOADS) {
      const batch = videoPaths.slice(i, i + MAX_PARALLEL_UPLOADS);
      const uploadPromises = batch.map(async (videoPath) => {
        try {
          await validateShorts(videoPath);
          const metadata = parseMetadata(videoPath);
          return await uploadVideo(auth, videoPath, metadata);
        } catch (err) {
          console.error(`❌ Failed to upload ${path.basename(videoPath)}:`, err.message);
          return null;
        }
      });

      await Promise.all(uploadPromises);
      
      // Add delay between batches if needed
      if (i + MAX_PARALLEL_UPLOADS < videoPaths.length) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    
    console.log('\n✨ Bulk upload completed!');
  } catch (err) {
    console.error('Bulk upload failed:', err.message);
  }
}

/**
 * Get all video files from a directory
 */
function getVideoFiles(directory) {
  try {
    const files = fs.readdirSync(directory);
    return files
      .filter(file => VIDEO_EXTENSIONS.includes(path.extname(file).toLowerCase()))
      .map(file => path.join(directory, file));
  } catch (err) {
    console.error('Error reading directory:', err.message);
    return [];
  }
}

/**
 * Authorize with YouTube API
 */
async function authorize() {
  try {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(
      client_id, 
      client_secret, 
      redirect_uris[0] || 'http://localhost:3000'
    );

    // Try to load existing token
    const token = loadToken();
    if (token) {
      oAuth2Client.setCredentials(token);
      return oAuth2Client;
    }

    // No token found, get new one
    return getNewToken(oAuth2Client);
  } catch (err) {
    console.error('Error loading credentials:', err.message);
    process.exit(1);
  }
}

/**
 * Load token from file
 */
function loadToken() {
  for (const tokenPath of TOKEN_PATHS) {
    try {
      if (fs.existsSync(tokenPath)) {
        const content = fs.readFileSync(tokenPath, 'utf8');
        return tokenPath.endsWith('.json') ? JSON.parse(content) : content.trim();
      }
    } catch (err) {
      console.warn(`⚠️ Could not read token from ${path.basename(tokenPath)}:`, err.message);
    }
  }
  return null;
}

/**
 * Get new OAuth token
 */
async function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('\n⚠️ Authorization required:');
  console.log('1. Open this URL in Chrome:', authUrl);
  console.log('2. Login with your YouTube account');
  console.log('3. Approve the permissions');
  console.log('4. Copy the authorization code from the URL after redirect\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve, reject) => {
    rl.question('Paste authorization code here: ', (code) => {
      rl.close();
      oAuth2Client.getToken(code, (err, token) => {
        if (err) return reject(err);
        oAuth2Client.setCredentials(token);
        saveToken(token);
        resolve(oAuth2Client);
      });
    });
  });
}

/**
 * Save token to file
 */
function saveToken(token) {
  try {
    fs.writeFileSync(TOKEN_PATHS[0], JSON.stringify(token));
    fs.writeFileSync(TOKEN_PATHS[1], token.access_token); 
    console.log(`🔑 Token saved to ${path.basename(TOKEN_PATHS[0])} and ${path.basename(TOKEN_PATHS[1])}`);
  } catch (err) {
    console.error('Error saving token:', err.message);
  }
}

/**
 * Main execution flow
 */
async function main() {
  console.log('\n📱 YouTube Shorts Bulk Uploader\n');

  // Get input path from command line or use default
  const inputPath = process.argv[2] || path.join(TERMUX_STORAGE, 'DCIM');

  if (fs.existsSync(inputPath)) {
    if (fs.lstatSync(inputPath).isDirectory()) {
      // Bulk upload all videos in directory
      const videoFiles = getVideoFiles(inputPath);
      if (videoFiles.length > 0) {
        console.log(`Found ${videoFiles.length} videos to upload:`);
        videoFiles.forEach((file, i) => console.log(`${i + 1}. ${path.basename(file)}`));
        
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        
        rl.question('\nProceed with bulk upload? (y/n) ', async (answer) => {
          rl.close();
          if (answer.toLowerCase() === 'y') {
            await bulkUpload(videoFiles);
          } else {
            console.log('Bulk upload cancelled.');
          }
        });
      } else {
        console.log('No video files found in directory.');
      }
    } else {
      // Single file upload (no scheduling)
      try {
        await validateShorts(inputPath);
        const metadata = parseMetadata(inputPath);
        const auth = await authorize();
        await uploadVideo(auth, inputPath, metadata);
      } catch (err) {
        console.error('Upload failed:', err.message);
      }
    }
  } else {
    console.error('Error: Path not found -', inputPath);
  }
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
});
