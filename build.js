const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const filesToInclude = [
  "manifest.json",
  "background.js",
  "dashboard.html",
  "dashboard.css",
  "dashboard.js",
  "gemini_content_script.js",
  "help.html",
  "popup.html",
  "popup.js",
  "storage.js",
  "styles.css",
  "icon-16.png",
  "icon-48.png",
  "icon-128.png",
  "logo.png",
  "logo_transparent.png"
];

const zipName = "lord-of-the-tabs-v1.0.0.zip";

// Ensure all files exist before zipping
for (const file of filesToInclude) {
  if (!fs.existsSync(file)) {
    console.error(`Error: Required file "${file}" does not exist!`);
    process.exit(1);
  }
}

// Remove existing zip if any
if (fs.existsSync(zipName)) {
  fs.unlinkSync(zipName);
  console.log(`Removed existing ${zipName}`);
}

console.log(`Packaging extension into ${zipName}...`);

if (process.platform === 'win32') {
  // Use PowerShell Compress-Archive
  const filesList = filesToInclude.map(f => `'${f}'`).join(', ');
  const cmd = `powershell -Command "Compress-Archive -Path ${filesList} -DestinationPath '${zipName}' -Force"`;
  try {
    execSync(cmd, { stdio: 'inherit' });
    console.log(`Successfully created ${zipName}`);
  } catch (err) {
    console.error('Error during PowerShell compression:', err.message);
    process.exit(1);
  }
} else {
  // Use zip command on macOS/Linux
  const filesList = filesToInclude.join(' ');
  const cmd = `zip -r ${zipName} ${filesList}`;
  try {
    execSync(cmd, { stdio: 'inherit' });
    console.log(`Successfully created ${zipName}`);
  } catch (err) {
    console.error('Error during zip compression:', err.message);
    process.exit(1);
  }
}
