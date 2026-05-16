/**
 * compile-local.js
 * Runs locally on Mac: downloads trigger images from Supabase, compiles
 * them into a .mind file using the Node.js compiler, then uploads the
 * result to the running server via POST /api/compile/:slug/upload.
 *
 * Usage: node compile-local.js [customer-slug]
 *        Defaults to 'olly' if no slug given.
 */

const path    = require('path')
const os      = require('os')
const fsp     = require('fs/promises')
const { fork } = require('child_process')

const CUSTOMER_SLUG   = process.argv[2] || 'olly'
const SERVER_URL      = 'http://localhost:3000'
const COMPILE_TIMEOUT = 300_000   // 5 minutes — generous for a big image set

async function main () {
  console.log(`\n━━━ Living Artwork local compiler ━━━`)
  console.log(`Customer slug: ${CUSTOMER_SLUG}`)

  // ── 1. Fetch artwork list ─────────────────────────────────────────────────
  console.log(`\nFetching artworks from ${SERVER_URL}/api/customer/${CUSTOMER_SLUG}/artworks …`)
  const listRes = await fetch(`${SERVER_URL}/api/customer/${CUSTOMER_SLUG}/artworks`)
  if (!listRes.ok) throw new Error(`API error ${listRes.status}: ${await listRes.text()}`)
  const { customer, artworks } = await listRes.json()
  if (!artworks?.length) throw new Error('No artworks found for this customer')

  console.log(`Customer: ${customer.name}`)
  artworks.forEach((a, i) => console.log(`  [${i + 1}] ${a.name}  →  ${a.trigger_url}`))

  // ── 2. Download trigger images to a temp dir ──────────────────────────────
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'living-artwork-compile-'))
  console.log(`\nTemp dir: ${tmpDir}`)

  try {
    const localPaths = []

    for (let i = 0; i < artworks.length; i++) {
      const url = artworks[i].trigger_url
      console.log(`Downloading image ${i + 1}/${artworks.length}: ${url.split('/').slice(-2).join('/')} …`)
      const imgRes = await fetch(url)
      if (!imgRes.ok) throw new Error(`Download failed: HTTP ${imgRes.status} — ${url}`)
      const buf = Buffer.from(await imgRes.arrayBuffer())
      const localPath = path.join(tmpDir, `img-${i}.png`)
      await fsp.writeFile(localPath, buf)
      localPaths.push(localPath)
      console.log(`  ✓ ${(buf.length / 1024).toFixed(0)} KB saved`)
    }

    // ── 3. Compile with the local Node.js compiler ────────────────────────
    console.log(`\nStarting compilation (${artworks.length} image(s)) …`)
    const mindBuffer = await compileLocally(localPaths)
    console.log(`\nCompilation complete: ${(mindBuffer.length / 1024).toFixed(0)} KB`)

    // ── 4. Build manifest: { "0": artworkId, "1": artworkId, … } ─────────────
    const manifest = {}
    artworks.forEach((a, i) => { manifest[String(i)] = a.id })
    console.log(`\nManifest: ${JSON.stringify(manifest)}`)

    // ── 5. Upload via the server endpoint ─────────────────────────────────────
    const uploadUrl = `${SERVER_URL}/api/compile/${CUSTOMER_SLUG}/upload`
    console.log(`\nUploading to ${uploadUrl} …`)

    const form = new FormData()
    form.append('mind', new Blob([mindBuffer], { type: 'application/octet-stream' }), 'targets.mind')
    form.append('manifest', JSON.stringify(manifest))

    const uploadRes = await fetch(uploadUrl, { method: 'POST', body: form })
    if (!uploadRes.ok) throw new Error(`Upload failed ${uploadRes.status}: ${await uploadRes.text()}`)

    const result = await uploadRes.json()
    console.log(`\n✓ Done!  mind URL: ${result.mindUrl}`)

  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true })
    console.log('Temp dir cleaned up.')
  }
}

// ── Local compiler: forks compiler.mjs via IPC ────────────────────────────────

function compileLocally (imagePaths) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'compiler.mjs'), [], {
      stdio: ['pipe', 'inherit', 'inherit', 'ipc']
    })

    let lastPct = -1

    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Compilation timed out after 5 minutes'))
    }, COMPILE_TIMEOUT)

    child.on('message', async (msg) => {
      switch (msg.type) {

        case 'ready':
          console.log('Compiler ready — sending image paths …')
          child.send({ type: 'compile', imagePaths })
          break

        case 'log':
          console.log(`  [compiler] ${msg.message}`)
          break

        case 'progress': {
          const p = msg.percent
          if (p !== lastPct) {
            process.stdout.write(`\r  Progress: ${p}%   `)
            lastPct = p
          }
          break
        }

        case 'done': {
          process.stdout.write('\n')
          clearTimeout(timeout)
          child.kill()
          try {
            const buf = await fsp.readFile(msg.path)
            await fsp.unlink(msg.path).catch(() => {})
            resolve(buf)
          } catch (err) {
            reject(err)
          }
          break
        }

        case 'error':
          process.stdout.write('\n')
          clearTimeout(timeout)
          child.kill()
          reject(new Error(msg.message))
          break
      }
    })

    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout)
        reject(new Error(`Compiler process exited with code ${code}`))
      }
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`Fork error: ${err.message}`))
    })
  })
}

main().catch(err => {
  console.error(`\n✗ ERROR: ${err.message}`)
  process.exit(1)
})
