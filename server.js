require('dotenv').config()
const express = require('express')
const multer = require('multer')
const { createClient } = require('@supabase/supabase-js')
const WebSocket = require('ws')
const cors = require('cors')
const path = require('path')
const os = require('os')
const fsp = require('fs/promises')
const sharp = require('sharp')

const SUPABASE_URL    = process.env.SUPABASE_URL
const SUPABASE_SECRET = process.env.SUPABASE_SECRET
const PORT = process.env.PORT || 3000

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: WebSocket },
  global: {
    fetch: (url, opts = {}) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120_000) // 2 min timeout for large uploads
      return fetch(url, { ...opts, signal: controller.signal })
        .finally(() => clearTimeout(timer))
    }
  }
})

const app = express()
app.use(cors())
app.use(express.json())

const upload = multer({ storage: multer.memoryStorage() })

// ── Storage init ──────────────────────────────────────────────────────────────

async function initBuckets () {
  for (const [name, isPublic] of [['artworks', true], ['minds', true]]) {
    const { error } = await supabase.storage.createBucket(name, { public: isPublic })
    if (error && !error.message.includes('already exists')) {
      console.error(`  ✗ bucket '${name}':`, error.message)
    } else {
      console.log(`  ✓ bucket '${name}': ready`)
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function publicUrl (bucket, storagePath) {
  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath)
  return data.publicUrl
}

// ── Trackability scoring ──────────────────────────────────────────────────────

function normalize10 (value, min, max) {
  const clamped = Math.max(min, Math.min(max, value))
  return Math.max(1, Math.min(10, Math.round(((clamped - min) / (max - min)) * 9 + 1)))
}

async function analyseTrackability (imageBuffer) {
  const grayPipeline = sharp(imageBuffer).flatten({ background: '#ffffff' }).greyscale()
  const stats = await grayPipeline.clone().stats()

  // Feature Points: sharpness (Laplacian-based edge strength)
  const score_features = normalize10(stats.sharpness || 0, 0, 300)

  // Contrast: standard deviation of greyscale channel
  const score_contrast = normalize10(stats.channels[0].stdev, 0, 70)

  // Uniqueness: Shannon entropy
  const score_uniqueness = normalize10(stats.entropy, 1, 8)

  // Distribution: count of 4×4 grid tiles that have texture
  const { data: rawBuf, info } = await grayPipeline.clone()
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const gridSize = 4
  const tileW = Math.floor(info.width / gridSize)
  const tileH = Math.floor(info.height / gridSize)
  let tilesWithTexture = 0

  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      let sum = 0, sumSq = 0, cnt = 0
      for (let y = gy * tileH; y < Math.min((gy + 1) * tileH, info.height); y++) {
        for (let x = gx * tileW; x < Math.min((gx + 1) * tileW, info.width); x++) {
          const v = rawBuf[y * info.width + x]
          sum += v; sumSq += v * v; cnt++
        }
      }
      if (cnt > 0) {
        const mean = sum / cnt
        if (Math.sqrt(Math.max(0, sumSq / cnt - mean * mean)) > 18) tilesWithTexture++
      }
    }
  }

  const score_distribution = normalize10(tilesWithTexture, 2, 14)
  const score_total = Math.round((score_features + score_distribution + score_contrast + score_uniqueness) / 4)

  return { score_features, score_distribution, score_contrast, score_uniqueness, score_total }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/customers
app.get('/api/customers', async (req, res) => {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .order('created_at', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// POST /api/customer  { name, slug }
app.post('/api/customer', async (req, res) => {
  const { name, slug } = req.body
  if (!name || !slug) return res.status(400).json({ error: 'name and slug required' })

  const { data, error } = await supabase
    .from('customers')
    .insert({ name, slug })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// POST /api/artwork/upload  (multipart: customer_slug, artwork_name, artwork_slug, trigger, video)
app.post('/api/artwork/upload',
  upload.fields([{ name: 'trigger', maxCount: 1 }, { name: 'video', maxCount: 1 }]),
  async (req, res) => {
    console.log('\n━━━ /api/artwork/upload ━━━')
    console.log('body fields:', req.body)
    console.log('files:', req.files
      ? Object.entries(req.files).map(([k,v]) => `${k}: ${v[0]?.originalname} (${v[0]?.size} bytes, ${v[0]?.mimetype})`)
      : 'none')

    const { customer_slug, artwork_name, artwork_slug } = req.body
    const triggerFile = req.files?.trigger?.[0]
    const videoFile = req.files?.video?.[0]

    if (!customer_slug || !artwork_name || !artwork_slug) {
      console.log('ERROR: missing body fields')
      return res.status(400).json({ error: 'customer_slug, artwork_name, artwork_slug required' })
    }
    if (!triggerFile || !videoFile) {
      console.log('ERROR: missing files — trigger:', !!triggerFile, 'video:', !!videoFile)
      return res.status(400).json({ error: 'trigger image and video both required' })
    }

    console.log('Looking up customer slug:', customer_slug)
    const { data: customer, error: custErr } = await supabase
      .from('customers').select('id').eq('slug', customer_slug).single()
    if (custErr || !customer) {
      console.log('ERROR: customer lookup failed:', custErr)
      return res.status(404).json({ error: 'Customer not found' })
    }
    console.log('Customer found, id:', customer.id)

    const basePath = `customers/${customer_slug}/artworks/${artwork_slug}`
    console.log('Storage base path:', basePath)

    const triggerMime = triggerFile.mimetype || 'image/png'
    const triggerBlob = new Blob([triggerFile.buffer], { type: triggerMime })
    console.log(`Uploading trigger image... (${(triggerFile.size/1024).toFixed(0)} KB, as Blob)`)
    const { data: tData, error: tErr } = await supabase.storage.from('artworks')
      .upload(`${basePath}/trigger.png`, triggerBlob, {
        contentType: triggerMime,
        upsert: true
      })
    if (tErr) {
      console.log('ERROR: trigger upload failed')
      console.log('  name:', tErr.name)
      console.log('  message:', tErr.message)
      console.log('  status:', tErr.status)
      console.log('  statusCode:', tErr.statusCode)
      console.log('  cause:', tErr.cause)
      console.log('  full:', JSON.stringify(tErr, null, 2))
      return res.status(500).json({ error: `Trigger upload: ${tErr.message}` })
    }
    console.log('Trigger uploaded OK:', tData?.path)

    const videoBlob = new Blob([videoFile.buffer], { type: 'video/mp4' })
    console.log(`Uploading video... (${(videoFile.size/1024/1024).toFixed(1)} MB, as Blob)`)
    const { data: vData, error: vErr } = await supabase.storage.from('artworks')
      .upload(`${basePath}/video.mp4`, videoBlob, {
        contentType: 'video/mp4',
        upsert: true
      })
    if (vErr) {
      console.log('ERROR: video upload failed')
      console.log('  name:', vErr.name)
      console.log('  message:', vErr.message)
      console.log('  status:', vErr.status)
      console.log('  statusCode:', vErr.statusCode)
      console.log('  cause:', vErr.cause)
      console.log('  full:', JSON.stringify(vErr, null, 2))
      return res.status(500).json({ error: `Video upload: ${vErr.message}` })
    }
    console.log('Video uploaded OK:', vData?.path)

    const triggerUrl = publicUrl('artworks', `${basePath}/trigger.png`)
    const videoUrl   = publicUrl('artworks', `${basePath}/video.mp4`)
    console.log('Public URLs:', { triggerUrl, videoUrl })

    // Analyse trackability scores from trigger image
    let scores = {}
    try {
      scores = await analyseTrackability(triggerFile.buffer)
      console.log('Trackability scores:', scores)
    } catch (e) {
      console.warn('Score analysis failed:', e.message)
    }

    console.log('Inserting artwork record...')
    const insertData = {
      customer_id: customer.id,
      name: artwork_name,
      slug: artwork_slug,
      trigger_url: triggerUrl,
      video_url: videoUrl,
      ...scores
    }

    let { data: artwork, error: artErr } = await supabase
      .from('artworks')
      .insert(insertData)
      .select()
      .single()

    if (artErr && artErr.message.includes('column') && Object.keys(scores).length > 0) {
      // Score columns not yet in DB — retry without scores
      console.warn('Score columns missing — run migrations/add_scores.sql. Retrying without scores...')
      const { score_features, score_distribution, score_contrast, score_uniqueness, score_total, ...baseData } = insertData
      const retry = await supabase.from('artworks').insert(baseData).select().single()
      artErr = retry.error
      artwork = retry.data
    }

    if (artErr) {
      console.log('ERROR: artwork DB insert failed:', JSON.stringify(artErr, null, 2))
      console.log('Stack:', artErr.stack || '(no stack)')
      return res.status(500).json({ error: artErr.message })
    }
    console.log('Artwork inserted OK:', artwork.id)
    res.json(artwork)
  }
)

// GET /api/customer/:slug/artworks
app.get('/api/customer/:slug/artworks', async (req, res) => {
  const { data: customer, error: custErr } = await supabase
    .from('customers').select('*').eq('slug', req.params.slug).single()
  if (custErr) return res.status(404).json({ error: 'Customer not found' })

  const { data: artworks, error } = await supabase
    .from('artworks')
    .select('*')
    .eq('customer_id', customer.id)
    .order('created_at', { ascending: true })

  if (error) return res.status(500).json({ error: error.message })
  res.json({ customer, artworks })
})

// DELETE /api/artwork/:id
app.delete('/api/artwork/:id', async (req, res) => {
  const { data: artwork, error: fetchErr } = await supabase
    .from('artworks')
    .select('slug, customers(slug)')
    .eq('id', req.params.id)
    .single()

  if (fetchErr || !artwork) return res.status(404).json({ error: 'Artwork not found' })

  const customerSlug = artwork.customers.slug
  const base = `customers/${customerSlug}/artworks/${artwork.slug}`

  await supabase.storage.from('artworks').remove([
    `${base}/trigger.png`,
    `${base}/video.mp4`
  ])

  const { error } = await supabase.from('artworks').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// POST /api/compile/:slug  — server-side compilation via Node.js child process + MindAR
app.post('/api/compile/:slug', async (req, res) => {
  const { slug } = req.params
  console.log(`\n━━━ /api/compile/${slug} ━━━`)

  try {
    // 1. Resolve customer + artworks
    const { data: customer, error: custErr } = await supabase
      .from('customers').select('id, name').eq('slug', slug).single()
    if (custErr || !customer) return res.status(404).json({ error: 'Customer not found' })

    const { data: artworks, error: artErr } = await supabase
      .from('artworks').select('trigger_url, slug, name').eq('customer_id', customer.id)
    if (artErr) return res.status(500).json({ error: artErr.message })
    if (!artworks?.length) return res.status(400).json({ error: 'No artworks found for this customer' })

    const imageUrls = artworks.map(a => a.trigger_url)
    console.log(`Compiling ${imageUrls.length} image(s) for "${customer.name}"`)
    imageUrls.forEach((u, i) => console.log(`  [${i + 1}] ${u}`))

    // 2. Compile using mind-ar npm package directly in Node.js (no browser)
    const mindBuffer = await compileWithMindAR(imageUrls)
    console.log(`Compiled OK — ${(mindBuffer.length / 1024).toFixed(0)} KB`)

    // 3. Upload .mind file to Supabase
    const mindPath = `customers/${slug}/targets.mind`
    const mindBlob = new Blob([mindBuffer], { type: 'application/octet-stream' })
    const { error: uploadErr } = await supabase.storage.from('minds')
      .upload(mindPath, mindBlob, { contentType: 'application/octet-stream', upsert: true })
    if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`)

    const mindUrl = publicUrl('minds', mindPath)

    // 4. Stamp mind_url on every artwork row for this customer
    await supabase.from('artworks').update({ mind_url: mindUrl }).eq('customer_id', customer.id)

    console.log(`Uploaded → ${mindUrl}`)
    res.json({ success: true, mindUrl, imageCount: artworks.length })

  } catch (err) {
    console.error('Compile ERROR:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/compile/:slug/upload  — accept a pre-compiled .mind file (fallback for slow servers)
app.post('/api/compile/:slug/upload',
  upload.single('mind'),
  async (req, res) => {
    const { slug } = req.params
    console.log(`\n━━━ /api/compile/${slug}/upload ━━━`)
    console.log('SUPABASE_URL:', SUPABASE_URL)
    console.log('SUPABASE_SECRET set:', !!SUPABASE_SECRET)

    if (!req.file) return res.status(400).json({ error: 'mind file required (field name: mind)' })
    console.log(`File: ${req.file.originalname}, ${(req.file.size / 1024).toFixed(1)} KB, ${req.file.mimetype}`)

    const { data: customer, error: custErr } = await supabase
      .from('customers').select('id').eq('slug', slug).single()
    if (custErr || !customer) {
      console.log('ERROR: customer lookup failed:', custErr)
      return res.status(404).json({ error: 'Customer not found' })
    }
    console.log('Customer found, id:', customer.id)

    const mindPath = `customers/${slug}/targets.mind`
    console.log(`Uploading to bucket 'minds' path: ${mindPath}`)
    const mindBlob = new Blob([req.file.buffer], { type: 'application/octet-stream' })
    const { data: uploadData, error: uploadErr } = await supabase.storage.from('minds')
      .upload(mindPath, mindBlob, { contentType: 'application/octet-stream', upsert: true })

    if (uploadErr) {
      console.log('ERROR: .mind upload failed')
      console.log('  name:', uploadErr.name)
      console.log('  message:', uploadErr.message)
      console.log('  status:', uploadErr.status)
      console.log('  statusCode:', uploadErr.statusCode)
      // Walk the cause chain — "fetch failed" errors nest the real reason here
      let cause = uploadErr.cause
      let depth = 0
      while (cause) {
        console.log(`  cause[${depth}]:`, cause?.message ?? cause)
        cause = cause?.cause
        depth++
      }
      console.log('  full:', JSON.stringify(uploadErr, Object.getOwnPropertyNames(uploadErr), 2))
      return res.status(500).json({ error: uploadErr.message })
    }
    console.log('Upload OK:', uploadData?.path)

    const mindUrl = publicUrl('minds', mindPath)
    console.log('Public URL:', mindUrl)
    const { error: updateErr } = await supabase.from('artworks').update({ mind_url: mindUrl }).eq('customer_id', customer.id)
    if (updateErr) console.log('WARN: mind_url update failed:', updateErr.message)

    console.log(`Uploaded .mind → ${mindUrl}`)
    res.json({ success: true, mindUrl })
  }
)

const COMPILE_TIMEOUT = 120_000  // 2 minutes

async function compileWithMindAR (imageUrls) {
  const { fork } = require('child_process')
  const t0 = Date.now()
  const ts = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`

  // ── Step 1: Download trigger images from Supabase to a temp dir ───────────
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'living-artwork-'))
  console.log(`${ts()} Temp dir: ${tmpDir}`)

  try {
    const localPaths = []
    for (let i = 0; i < imageUrls.length; i++) {
      console.log(`${ts()} Downloading image ${i + 1}/${imageUrls.length}…`)
      const response = await fetch(imageUrls[i])
      if (!response.ok) throw new Error(`Image download failed: HTTP ${response.status} — ${imageUrls[i]}`)
      const buf = Buffer.from(await response.arrayBuffer())
      const localPath = path.join(tmpDir, `img-${i}.png`)
      await fsp.writeFile(localPath, buf)
      localPaths.push(localPath)
      console.log(`${ts()} Saved ${(buf.length / 1024).toFixed(0)} KB → ${localPath}`)
    }

    // ── Step 2: Fork compiler.mjs and run compilation ──────────────────────
    console.log(`${ts()} Forking compiler.mjs…`)
    return await new Promise((resolve, reject) => {
      const child = fork(path.join(__dirname, 'compiler.mjs'), [], {
        // stdio: inherit stderr so compiler crashes print immediately
        stdio: ['pipe', 'inherit', 'inherit', 'ipc']
      })

      let lastPct = -1
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error('Compilation timed out after 2 minutes'))
      }, COMPILE_TIMEOUT)

      child.on('message', (msg) => {
        switch (msg.type) {
          case 'ready':
            console.log(`${ts()} Compiler ready — sending image paths`)
            child.send({ type: 'compile', imagePaths: localPaths })
            break
          case 'log':
            console.log(`${ts()} [compiler] ${msg.message}`)
            break
          case 'progress': {
            const p = msg.percent
            if (p !== lastPct) {
              process.stdout.write(`\r${ts()} [compiler] ${p}%   `)
              lastPct = p
            }
            break
          }
          case 'done': {
            process.stdout.write('\n')
            clearTimeout(timeout)
            child.kill()
            // Compiler wrote output to a temp file to avoid a multi-MB IPC payload
            fsp.readFile(msg.path)
              .then(buf => {
                console.log(`${ts()} [compiler] done — ${(buf.length / 1024).toFixed(0)} KB`)
                fsp.unlink(msg.path).catch(() => {})
                resolve(buf)
              })
              .catch(reject)
            break
          }
          case 'error':
            process.stdout.write('\n')
            console.error(`${ts()} [compiler] ERROR:`, msg.message)
            if (msg.stack) console.error(msg.stack)
            clearTimeout(timeout)
            child.kill()
            reject(new Error(msg.message))
            break
        }
      })

      child.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout)
          reject(new Error(`Compiler process exited with code ${code}`))
        }
      })

      child.on('error', (err) => {
        clearTimeout(timeout)
        reject(new Error(`Failed to fork compiler: ${err.message}`))
      })
    })

  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true })
    console.log(`\nTemp dir cleaned up`)
  }
}

// ── Static / Admin page ───────────────────────────────────────────────────────

app.use('/public', express.static(path.join(__dirname, 'public')))

app.get('/olly/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
})

app.get('/olly/ar', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'))
})

app.get('/', (req, res) => res.redirect('/olly/admin'))

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\nLiving Artwork Admin`)
  console.log(`═══════════════════════════════════`)
  console.log(`Server:  http://localhost:${PORT}`)
  console.log(`Admin:   http://localhost:${PORT}/olly/admin`)
  console.log(`AR:      http://localhost:${PORT}/olly/ar`)
  console.log(`═══════════════════════════════════`)
  console.log('Initialising Supabase storage...')
  await initBuckets()
  console.log('Ready.\n')
})
