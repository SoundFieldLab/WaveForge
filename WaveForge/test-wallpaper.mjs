/**
 * 壁纸检测功能独立测试脚本
 * 用于验证 Windows 壁纸读取逻辑
 */

import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';

console.log('🧪 WaveForge 壁纸检测测试脚本\n');

// 测试 1: 检查操作系统
console.log('📋 测试 1: 检查操作系统');
console.log(`   当前系统: ${os.platform()}`);
if (os.platform() !== 'win32') {
  console.log('   ❌ 此功能仅支持 Windows 系统');
  process.exit(1);
}
console.log('   ✅ 系统检查通过\n');

// 测试 2: PowerShell 可用性
console.log('📋 测试 2: 检查 PowerShell 可用性');
exec('powershell -Command "Write-Output OK"', (error, stdout, stderr) => {
  if (error) {
    console.log('   ❌ PowerShell 不可用:', error.message);
    return;
  }
  console.log('   ✅ PowerShell 可用\n');
  
  // 测试 3: 读取注册表壁纸路径
  testGetWallpaper();
});

function testGetWallpaper() {
  console.log('📋 测试 3: 读取注册表壁纸路径');
  
  const command = `powershell -NoProfile -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-ItemPropertyValue -Path 'HKCU:\\Control Panel\\Desktop' -Name Wallpaper"`;

  exec(command, { 
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 
  }, (error, stdout, stderr) => {
    if (error) {
      console.log('   ❌ 读取失败:', error.message);
      if (stderr) console.log('   错误输出:', stderr);
      return;
    }

    const wallpaperPath = stdout.trim();
    console.log(`   壁纸路径: ${wallpaperPath}`);

    if (!wallpaperPath) {
      console.log('   ❌ 未获取到壁纸路径\n');
      return;
    }

    // 测试 4: 检查文件是否存在
    testFileExists(wallpaperPath);
  });
}

function testFileExists(wallpaperPath) {
  console.log('\n📋 测试 4: 检查壁纸文件是否存在');
  
  if (fs.existsSync(wallpaperPath)) {
    console.log('   ✅ 文件存在');
    
    // 获取文件信息
    const stats = fs.statSync(wallpaperPath);
    console.log(`   文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   修改时间: ${stats.mtime.toLocaleString()}`);
    
    // 测试 5: 转换为 file:// URL
    testUrlConversion(wallpaperPath);
  } else {
    console.log('   ❌ 文件不存在');
  }
}

function testUrlConversion(wallpaperPath) {
  console.log('\n📋 测试 5: 路径转换为 file:// URL');
  
  const fileUrl = 'file:///' + wallpaperPath.replace(/\\/g, '/');
  console.log(`   原始路径: ${wallpaperPath}`);
  console.log(`   转换结果: ${fileUrl}`);
  console.log('   ✅ 转换成功\n');
  
  // 测试总结
  printSummary(wallpaperPath, fileUrl);
}

function printSummary(wallpaperPath, fileUrl) {
  console.log('═══════════════════════════════════════════════════');
  console.log('🎉 测试完成！所有检查通过\n');
  console.log('📊 测试结果摘要:');
  console.log('   ✅ 操作系统支持');
  console.log('   ✅ PowerShell 可用');
  console.log('   ✅ 成功读取壁纸路径');
  console.log('   ✅ 壁纸文件存在');
  console.log('   ✅ URL 转换正确\n');
  console.log('🔗 最终输出:');
  console.log(`   ${fileUrl}\n`);
  console.log('💡 提示:');
  console.log('   - 在 Electron 中使用此 URL 作为背景图片');
  console.log('   - 每 10 秒轮询此脚本检测壁纸变化');
  console.log('   - 将 URL 发送到渲染进程更新背景\n');
  console.log('🚀 下一步:');
  console.log('   1. 运行 npm run dev 启动前端');
  console.log('   2. 运行 npm run dev:electron 启动应用');
  console.log('   3. 进入桌面模式并启用壁纸同步');
  console.log('═══════════════════════════════════════════════════');
}
