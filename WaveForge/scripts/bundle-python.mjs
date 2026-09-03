#!/usr/bin/env node

/**
 * Python 嵌入式环境打包脚本
 * 
 * 功能：
 * 1. 下载 Python 嵌入式版本
 * 2. 安装 pip
 * 3. 安装项目依赖到嵌入式环境
 * 4. 打包到 resources/python-embed/
 */

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import https from 'https'
import { fileURLToPath } from 'url'
import { exec } from 'child_process'
import { promisify } from 'util'
import AdmZip from 'adm-zip'

const execAsync = promisify(exec)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PROJECT_ROOT = path.resolve(__dirname, '..')
const PYTHON_EMBED_DIR = path.join(PROJECT_ROOT, 'resources', 'python-embed')
const CANONICAL_REQUIREMENTS_PATH = path.join(PROJECT_ROOT, 'requirements.txt')
const PYTHON_VERSION = '3.13.15' // 使用稳定版本
const PYTHON_ARCH = 'amd64' // 64位

const BEAT_THIS_MODEL_DIR = path.join(PROJECT_ROOT, 'resources', 'beat-this')
const BEAT_THIS_MODEL_PATH = path.join(BEAT_THIS_MODEL_DIR, 'final0.ckpt')
const BEAT_THIS_MODEL_METADATA_PATH = path.join(BEAT_THIS_MODEL_DIR, 'model.json')
const BEAT_THIS_MODEL_METADATA = {
  schemaVersion: 1,
  provider: 'beat-this',
  version: '1.1.0',
  modelId: 'final0',
  file: 'final0.ckpt',
  bytes: 81058141,
  sha256: '8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331',
  bundled: true,
  acquisitionRequired: false,
}

// Python 嵌入式版本下载 URL
const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-${PYTHON_ARCH}.zip`
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py'

console.log('🐍 WaveForge Python 嵌入式环境打包工具\n')

/**
 * 下载文件
 */
async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath)
    console.log(`📥 下载: ${url}`)
    
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // 处理重定向
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject)
      }
      
      const totalSize = parseInt(response.headers['content-length'], 10)
      let downloaded = 0
      
      response.on('data', (chunk) => {
        downloaded += chunk.length
        const percent = ((downloaded / totalSize) * 100).toFixed(1)
        process.stdout.write(`\r   进度: ${percent}% (${(downloaded / 1024 / 1024).toFixed(2)} MB)`)
      })
      
      response.pipe(file)
      
      file.on('finish', () => {
        file.close()
        console.log('\n✅ 下载完成')
        resolve()
      })
    }).on('error', (err) => {
      fs.unlinkSync(destPath)
      reject(err)
    })
  })
}

/**
 * 解压 ZIP 文件
 */
function extractZip(zipPath, destDir) {
  console.log(`📦 解压到: ${destDir}`)
  const zip = new AdmZip(zipPath)
  zip.extractAllTo(destDir, true)
  console.log('✅ 解压完成')
}

/**
 * 启用 pip 支持
 */
function enablePip(pythonDir) {
  console.log('🔧 配置 pip 支持...')
  
  // 修改 python313._pth 文件以启用 site-packages
  const pthFile = path.join(pythonDir, `python${PYTHON_VERSION.split('.').slice(0, 2).join('')}._pth`)
  
  if (fs.existsSync(pthFile)) {
    let content = fs.readFileSync(pthFile, 'utf-8')
    
    // 取消注释 import site
    content = content.replace('#import site', 'import site')
    
    // 添加 Lib/site-packages 到路径
    if (!content.includes('Lib/site-packages')) {
      content += '\nLib/site-packages\n'
    }
    
    fs.writeFileSync(pthFile, content, 'utf-8')
    console.log('✅ pip 支持已启用')
  } else {
    console.warn('⚠️  未找到 ._pth 文件，跳过配置')
  }
}

/**
 * 安装 pip
 */
async function installPip(pythonDir) {
  console.log('📦 安装 pip...')
  
  const getPipPath = path.join(pythonDir, 'get-pip.py')
  const pythonExe = path.join(pythonDir, 'python.exe')

  // 网络不稳时允许预放置 get-pip.py（与上方 Python zip 同样的跳过逻辑）
  if (!fs.existsSync(getPipPath)) {
    await downloadFile(GET_PIP_URL, getPipPath)
  } else {
    console.log('⏭️  get-pip.py 已存在，跳过下载')
  }
  
  // 运行 get-pip.py
  console.log('⚙️  运行 pip 安装程序...')
  const { stdout, stderr } = await execAsync(`"${pythonExe}" "${getPipPath}"`)
  
  if (stderr && !stderr.includes('WARNING')) {
    console.error('stderr:', stderr)
  }
  
  console.log('✅ pip 安装完成')
  
  // 清理
  fs.unlinkSync(getPipPath)
}

function verifyBeatThisModel() {
  if (!fs.existsSync(BEAT_THIS_MODEL_PATH)) {
    throw new Error(`缺少必要的 Beat This 模型: ${BEAT_THIS_MODEL_PATH}`)
  }
  const bytes = fs.statSync(BEAT_THIS_MODEL_PATH).size
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(BEAT_THIS_MODEL_PATH)).digest('hex')
  if (bytes !== BEAT_THIS_MODEL_METADATA.bytes || sha256 !== BEAT_THIS_MODEL_METADATA.sha256) {
    throw new Error(`Beat This final0 完整性校验失败（bytes=${bytes}, sha256=${sha256}）`)
  }
  fs.writeFileSync(BEAT_THIS_MODEL_METADATA_PATH, `${JSON.stringify(BEAT_THIS_MODEL_METADATA, null, 2)}\n`, 'utf8')
  console.log('✅ Beat This final0 模型完整性校验通过')
}

/**
 * 安装 Python 依赖
 */
async function installDependencies(pythonDir) {
  console.log('📦 安装项目依赖...')
  
  const pythonExe = path.join(pythonDir, 'python.exe')
  const requirementsPath = CANONICAL_REQUIREMENTS_PATH
  
  if (!fs.existsSync(requirementsPath)) {
    throw new Error(`未找到规范依赖锁文件: ${requirementsPath}`)
  }
  
  // 镜像源由调用方控制（pip 原生 PIP_INDEX_URL 环境变量）。依赖锁、平台和
  // wheel-only 策略由此脚本固定，避免构建环境解析出不同的 Beat This/Torch 组合。
  console.log(`⚙️  安装锁定依赖: ${path.relative(PROJECT_ROOT, requirementsPath)}`)
  console.log(`⚙️  平台: CPython ${PYTHON_VERSION} win_amd64${process.env.PIP_INDEX_URL ? `；镜像：${process.env.PIP_INDEX_URL}` : '；pip 默认索引'}`)
  // proxy-tools 0.1.0 is a small pure-Python dependency of pywebview and has no wheel.
  // Install that exact source distribution first; every remaining package stays wheel-only.
  await execAsync(`"${pythonExe}" -m pip install proxy-tools==0.1.0 --no-deps --no-warn-script-location --disable-pip-version-check`, { maxBuffer: 10 * 1024 * 1024 })
  const cmd = `"${pythonExe}" -m pip install --requirement "${requirementsPath}" --only-binary :all: --no-warn-script-location --disable-pip-version-check`
  
  const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 })
  
  console.log(stdout)
  if (stderr && !stderr.includes('WARNING')) {
    console.error('stderr:', stderr)
  }
  
  console.log('✅ 依赖安装完成')
}

/**
 * 清理缓存文件
 */
function cleanupCache(pythonDir) {
  console.log('🧹 清理缓存文件...')
  
  const patternsToDelete = [
    '**/__pycache__',
    '**/*.pyc',
    '**/*.pyo',
    '**/pip-*.dist-info',
    '**/setuptools-*.dist-info',
  ]
  
  // 简单删除 __pycache__ 目录
  function deletePycache(dir) {
    if (!fs.existsSync(dir)) return
    
    const items = fs.readdirSync(dir, { withFileTypes: true })
    
    for (const item of items) {
      const fullPath = path.join(dir, item.name)
      
      if (item.isDirectory()) {
        if (item.name === '__pycache__') {
          fs.rmSync(fullPath, { recursive: true, force: true })
          console.log(`   删除: ${fullPath}`)
        } else {
          deletePycache(fullPath)
        }
      }
    }
  }
  
  deletePycache(pythonDir)
  console.log('✅ 清理完成')
}

/**
 * 创建版本信息文件
 */
function createVersionInfo(pythonDir) {
  const versionInfo = {
    pythonVersion: PYTHON_VERSION,
    arch: PYTHON_ARCH,
    createdAt: new Date().toISOString(),
    canonicalRequirements: path.relative(PROJECT_ROOT, CANONICAL_REQUIREMENTS_PATH).replaceAll('\\', '/'),
    modelAcquisition: BEAT_THIS_MODEL_METADATA,
    packages: {}
  }
  
  const pythonExe = path.join(pythonDir, 'python.exe')
  
  return execAsync(`"${pythonExe}" -m pip list --format=json`)
    .then(({ stdout }) => {
      const packages = JSON.parse(stdout)
      packages.forEach(pkg => {
        versionInfo.packages[pkg.name] = pkg.version
      })
      const infoPath = path.join(pythonDir, 'VERSION.json')
      fs.writeFileSync(infoPath, JSON.stringify(versionInfo, null, 2))
      console.log('✅ 版本和模型获取信息已保存')
    })
}

/**
 * 主函数
 */
async function main() {
  try {
    // 1. Verify the required bundled model before rebuilding the runtime.
    verifyBeatThisModel()

    // 2. 创建目录
    console.log('📁 创建目录结构...')
    fs.mkdirSync(PYTHON_EMBED_DIR, { recursive: true })
    
    const tempDir = path.join(PROJECT_ROOT, 'temp-python-download')
    fs.mkdirSync(tempDir, { recursive: true })
    
    // 2. 下载 Python 嵌入式版本
    const zipPath = path.join(tempDir, 'python-embed.zip')
    
    if (!fs.existsSync(zipPath)) {
      await downloadFile(PYTHON_EMBED_URL, zipPath)
    } else {
      console.log('⏭️  Python 安装包已存在，跳过下载')
    }
    
    // 3. 解压
    extractZip(zipPath, PYTHON_EMBED_DIR)
    
    // 4. 启用 pip
    enablePip(PYTHON_EMBED_DIR)
    
    // 5. 安装 pip
    await installPip(PYTHON_EMBED_DIR)
    
    // 6. 安装依赖
    await installDependencies(PYTHON_EMBED_DIR)
    
    // 7. 清理缓存
    cleanupCache(PYTHON_EMBED_DIR)
    
    // 8. 创建版本信息
    await createVersionInfo(PYTHON_EMBED_DIR)
    
    // 9. 清理临时文件
    console.log('🧹 清理临时文件...')
    fs.rmSync(tempDir, { recursive: true, force: true })
    
    console.log('\n✅ Python 嵌入式环境打包完成！')
    console.log(`📂 位置: ${PYTHON_EMBED_DIR}`)
    console.log('\n下一步：')
    console.log('  1. 更新 render-runtime.cjs 使用嵌入式 Python')
    console.log('  2. 在 package.json 的 build.files 中添加 "resources/python-embed/**/*"')
    console.log('  3. 运行 npm run build:electron 测试打包')
    
  } catch (error) {
    console.error('\n❌ 错误:', error.message)
    process.exit(1)
  }
}

main()
