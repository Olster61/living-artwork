/**
 * compiler.mjs — spawned as a child process by server.js
 * Compiles trigger images into a .mind file using mind-ar's Node.js-compatible
 * OfflineCompiler logic, with sharp replacing the canvas npm package.
 *
 * Protocol (IPC):
 *   parent → child : { type: 'compile', imagePaths: string[] }
 *   child  → parent: { type: 'ready' }
 *                    { type: 'log',      message: string }
 *                    { type: 'progress', percent: number }
 *                    { type: 'done',     data: number[] }   ← Uint8Array as plain array
 *                    { type: 'error',    message, stack }
 */

import { readFile, writeFile } from 'fs/promises'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import os from 'os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require   = createRequire(import.meta.url)

// ── sharp (CommonJS package, use require) ─────────────────────────────────────
const sharp = require('sharp')

// ── TensorFlow.js — register CPU backend explicitly ──────────────────────────
import * as tf from '@tensorflow/tfjs'
import '@tensorflow/tfjs-backend-cpu'

log('Setting TF.js backend to CPU…')
await tf.setBackend('cpu')
await tf.ready()
log(`TF.js ${tf.version.tfjs} ready on backend: ${tf.getBackend()}`)

// ── mind-ar internal modules (ES modules, no canvas, no web workers) ─────────
import { CompilerBase }           from './node_modules/mind-ar/src/image-target/compiler-base.js'
import { buildTrackingImageList } from './node_modules/mind-ar/src/image-target/image-list.js'
import { extractTrackingFeatures } from './node_modules/mind-ar/src/image-target/tracker/extract-utils.js'

// Register the CPU-specific TF.js kernels that mind-ar needs
import './node_modules/mind-ar/src/image-target/detector/kernels/cpu/index.js'
log('mind-ar modules loaded')

// ── NodeCompiler ──────────────────────────────────────────────────────────────
class NodeCompiler extends CompilerBase {
  /**
   * Instead of creating a real canvas, return a fake one whose getImageData()
   * returns the RGBA data already loaded by sharp. The img object has
   * _rgbaData: Uint8ClampedArray attached by compile() below.
   */
  createProcessCanvas (img) {
    const rgbaData = img._rgbaData
    return {
      width:  img.width,
      height: img.height,
      getContext: () => ({
        drawImage:    () => {},            // no-op — data already in rgbaData
        getImageData: () => ({ data: rgbaData })
      })
    }
  }

  /**
   * Synchronous track compilation — mirrors OfflineCompiler.compileTrack
   * but without the canvas import that OfflineCompiler carries.
   */
  compileTrack ({ progressCallback, targetImages, basePercent }) {
    return new Promise((resolve) => {
      const percentPerImage = (100 - basePercent) / targetImages.length
      let totalPercent = 0
      const list = []

      for (const targetImage of targetImages) {
        const imageList      = buildTrackingImageList(targetImage)
        const percentPerStep = percentPerImage / imageList.length
        const trackingData   = extractTrackingFeatures(imageList, () => {
          totalPercent += percentPerStep
          progressCallback(basePercent + totalPercent)
        })
        list.push(trackingData)
      }

      resolve(list)
    })
  }
}

// ── Main compile function ─────────────────────────────────────────────────────
async function compile (imagePaths) {
  const compiler = new NodeCompiler()
  const images   = []

  for (let i = 0; i < imagePaths.length; i++) {
    log(`Loading image ${i + 1}/${imagePaths.length}: ${path.basename(imagePaths[i])}`)
    const buf = await readFile(imagePaths[i])

    const { data: rawPixels, info } = await sharp(buf)
      .ensureAlpha()           // ensure 4-channel RGBA
      .raw()
      .toBuffer({ resolveWithObject: true })

    log(`  → ${info.width}×${info.height}px, ${(buf.length / 1024).toFixed(0)} KB`)

    images.push({
      width:     info.width,
      height:    info.height,
      _rgbaData: new Uint8ClampedArray(rawPixels.buffer, rawPixels.byteOffset, rawPixels.byteLength)
    })
  }

  log('Starting compileImageTargets…')
  let lastLoggedPct = -1

  await compiler.compileImageTargets(images, (pct) => {
    const p = Math.floor(pct)
    process.send({ type: 'progress', percent: p })
    if (p !== lastLoggedPct && p % 10 === 0) {
      log(`  compile progress: ${p}%`)
      lastLoggedPct = p
    }
  })

  log('Exporting .mind data…')
  const buffer = compiler.exportData()
  log(`Export done: ${buffer.byteLength} bytes (${(buffer.byteLength / 1024).toFixed(0)} KB)`)

  // Write to a temp file and send the path — avoids serialising megabytes of binary over IPC
  const outPath = path.join(os.tmpdir(), `mind-${Date.now()}.mind`)
  await writeFile(outPath, Buffer.from(buffer))
  log(`Written to temp file: ${outPath}`)
  process.send({ type: 'done', path: outPath })
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function log (msg) {
  process.send({ type: 'log', message: msg })
}

// ── IPC listener ─────────────────────────────────────────────────────────────
process.on('message', (msg) => {
  if (msg.type === 'compile') {
    compile(msg.imagePaths).catch((err) => {
      process.send({ type: 'error', message: err.message, stack: err.stack })
    })
  }
})

// Signal to parent that we are initialised and ready
process.send({ type: 'ready' })
