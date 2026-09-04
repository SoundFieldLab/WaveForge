const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const logoPath = path.join(__dirname, '..', 'logo超分.png');
const buildDir = path.join(__dirname, '..', 'build');
const iconPath = path.join(buildDir, 'icon.ico');

// 确保 build 目录存在
if (!fs.existsSync(buildDir)) {
  fs.mkdirSync(buildDir, { recursive: true });
}

console.log('Generating icon.ico from logo超分.png...');

try {
  // 使用 sharp 生成多尺寸 PNG
  const sharp = require('sharp');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const tempFiles = [];

  async function generateIcon() {
    // 生成各个尺寸的 PNG
    for (const size of sizes) {
      const tempFile = path.join(buildDir, `icon-${size}.png`);
      await sharp(logoPath)
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(tempFile);
      tempFiles.push(tempFile);
      console.log(`Generated ${size}x${size} icon`);
    }

    // 使用 png-to-ico 将 PNG 转换为 ICO
    const pngToIco = require('png-to-ico');
    const icoBuffer = await pngToIco.default(tempFiles);
    fs.writeFileSync(iconPath, icoBuffer);
    
    console.log(`✓ icon.ico generated at ${iconPath}`);

    // 清理临时文件
    tempFiles.forEach(file => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });
  }

  generateIcon().catch(err => {
    console.error('Error generating icon:', err);
    process.exit(1);
  });

} catch (err) {
  console.error('Error: sharp or png-to-ico not installed');
  console.log('Installing dependencies...');
  execSync('npm install sharp png-to-ico --save-dev', { stdio: 'inherit' });
  console.log('Please run this script again.');
  process.exit(1);
}
