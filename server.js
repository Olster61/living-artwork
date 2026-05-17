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
  for (const [name, isPublic] of [['artworks', true], ['minds', true], ['ideas-files', true]]) {
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

// ── Ideas-files helpers ───────────────────────────────────────────────────────

const IDEAS_BUCKET   = 'ideas-files'
const IDEAS_PUB_BASE = `${SUPABASE_URL}/storage/v1/object/public/${IDEAS_BUCKET}/`

// Extract the bare storage path from whatever is stored in file_url.
// Handles old records (full public URL) and new records (plain path).
function ideasFilePath (fileUrl) {
  if (!fileUrl) return null
  if (fileUrl.startsWith(IDEAS_PUB_BASE)) return fileUrl.slice(IDEAS_PUB_BASE.length)
  return fileUrl
}

// Replace file_url on each idea_files row with a 1-hour signed URL (single batch call).
async function withSignedUrlsForFiles (files) {
  if (!files || !files.length) return files || []
  const paths = files.map(f => ideasFilePath(f.file_url)).filter(Boolean)
  if (!paths.length) return files
  const { data: signed } = await supabase.storage.from(IDEAS_BUCKET).createSignedUrls(paths, 3600)
  const urlMap = {}
  if (signed) signed.forEach(s => { if (s.signedUrl) urlMap[s.path] = s.signedUrl })
  return files.map(f => {
    const path = ideasFilePath(f.file_url)
    return { ...f, file_url: (path && urlMap[path]) || f.file_url }
  })
}

const EXTERNAL_TYPES = new Set(['youtube', 'instagram'])

// Replace file_url on each idea with a 1-hour signed URL (single batch call).
// External URLs (YouTube, Instagram, etc.) are passed through unchanged.
async function withSignedUrls (ideas) {
  const withFiles = ideas.filter(i => i.file_url && !EXTERNAL_TYPES.has(i.file_type))
  if (!withFiles.length) return ideas

  const paths = withFiles.map(i => ideasFilePath(i.file_url))
  const { data: signed } = await supabase.storage
    .from(IDEAS_BUCKET)
    .createSignedUrls(paths, 3600)

  const urlMap = {}
  if (signed) signed.forEach(s => { if (s.signedUrl) urlMap[s.path] = s.signedUrl })

  return ideas.map(idea => {
    if (!idea.file_url || EXTERNAL_TYPES.has(idea.file_type)) return idea
    const path = ideasFilePath(idea.file_url)
    return { ...idea, file_url: urlMap[path] || idea.file_url }
  })
}

// ── Trackability scoring ──────────────────────────────────────────────────────

function normalize10 (value, min, max) {
  const clamped = Math.max(min, Math.min(max, value))
  return Math.max(1, Math.min(10, Math.round(((clamped - min) / (max - min)) * 9 + 1)))
}

async function analyseTrackability (imageBuffer) {
  const baseImg = sharp(imageBuffer).flatten({ background: '#ffffff' })

  // Run greyscale stats, colour stats, and raw tile buffer in parallel
  const [grayStats, colStats, { data: rawBuf, info }] = await Promise.all([
    baseImg.clone().greyscale().stats(),
    baseImg.clone().stats(),
    baseImg.clone()
      .greyscale()
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true })
  ])

  // Build per-tile stdev across a 4×4 grid
  const gridSize = 4
  const tileW = Math.floor(info.width / gridSize)
  const tileH = Math.floor(info.height / gridSize)
  const tileStdevs = []

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
        tileStdevs.push(Math.sqrt(Math.max(0, sumSq / cnt - mean * mean)))
      }
    }
  }

  const meanTileStdev    = tileStdevs.reduce((a, b) => a + b, 0) / tileStdevs.length
  const tilesWithTexture = tileStdevs.filter(s => s > 18).length

  // Feature Points: √(mean tile stdev) captures edge density across the image.
  // sqrt compresses the range so white-background illustrations aren't harshly penalised
  // while still differentiating sparse from dense images. Calibrated: sparse~4, dense~9.
  const score_features = normalize10(Math.sqrt(meanTileStdev), 1, 7)

  // Distribution: count of 4×4 grid tiles that contain texture (stdev > 18)
  const score_distribution = normalize10(tilesWithTexture, 1, 14)

  // Contrast: standard deviation of greyscale channel
  const score_contrast = normalize10(grayStats.channels[0].stdev, 10, 80)

  // Uniqueness: mean colour-channel stdev — rewards colour variety over greyscale flatness
  const chans = colStats.channels
  const meanColStdev = chans.length >= 3
    ? (chans[0].stdev + chans[1].stdev + chans[2].stdev) / 3
    : chans[0].stdev
  const score_uniqueness = normalize10(meanColStdev, 10, 70)

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
      .from('artworks').select('id, trigger_url, slug, name').eq('customer_id', customer.id)
      .order('created_at', { ascending: true })
    if (artErr) return res.status(500).json({ error: artErr.message })
    if (!artworks?.length) return res.status(400).json({ error: 'No artworks found for this customer' })

    const imageUrls = artworks.map(a => a.trigger_url)
    console.log(`Compiling ${imageUrls.length} image(s) for "${customer.name}"`)
    imageUrls.forEach((u, i) => console.log(`  [${i + 1}] ${u}`))

    // 2. Compile using mind-ar npm package directly in Node.js (no browser)
    const mindBuffer = await compileWithMindAR(imageUrls)
    console.log(`Compiled OK — ${(mindBuffer.length / 1024).toFixed(0)} KB`)

    // 3. Upload .mind file + manifest to Supabase
    const mindPath     = `customers/${slug}/targets.mind`
    const manifestPath = `customers/${slug}/targets-manifest.json`

    // Build manifest: { "0": artworkId, "1": artworkId, … }
    const manifest = {}
    artworks.forEach((a, i) => { manifest[String(i)] = a.id })
    const manifestBuf = Buffer.from(JSON.stringify(manifest))

    const [{ error: uploadErr }, { error: manifestErr }] = await Promise.all([
      supabase.storage.from('minds').upload(mindPath, mindBuffer, { contentType: 'application/octet-stream', upsert: true }),
      supabase.storage.from('minds').upload(manifestPath, manifestBuf, { contentType: 'application/json', upsert: true }),
    ])
    if (uploadErr)   throw new Error(`Storage upload failed: ${uploadErr.message}`)
    if (manifestErr) console.warn('Manifest upload warning:', manifestErr.message)

    const mindUrl = publicUrl('minds', mindPath)
    console.log('Manifest:', JSON.stringify(manifest))

    // 4. Stamp mind_url on every artwork row for this customer
    await supabase.from('artworks').update({ mind_url: mindUrl }).eq('customer_id', customer.id)

    console.log(`Uploaded → ${mindUrl}`)
    res.json({ success: true, mindUrl, imageCount: artworks.length, manifest })

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
    // Pass Buffer directly — avoids the FormData+Blob wrapping the SDK applies to Blob
    // inputs, which is the flaky code path in Node.js's undici-backed fetch.
    const { data: uploadData, error: uploadErr } = await supabase.storage.from('minds')
      .upload(mindPath, req.file.buffer, { contentType: 'application/octet-stream', upsert: true })

    if (uploadErr) {
      console.log('ERROR: .mind upload failed')
      console.log('  name:', uploadErr.name)
      console.log('  message:', uploadErr.message)
      console.log('  status:', uploadErr.status)
      console.log('  statusCode:', uploadErr.statusCode)
      // The SDK stores the underlying error on originalError, not cause
      const orig = uploadErr.originalError
      if (orig) {
        console.log('  originalError:', orig?.message)
        let c = orig?.cause; let d = 0
        while (c) { console.log(`  cause[${d}]:`, c?.message ?? c); c = c?.cause; d++ }
      }
      return res.status(500).json({ error: uploadErr.message })
    }
    console.log('Upload OK:', uploadData?.path)

    const mindUrl = publicUrl('minds', mindPath)
    console.log('Public URL:', mindUrl)
    const { error: updateErr } = await supabase.from('artworks').update({ mind_url: mindUrl }).eq('customer_id', customer.id)
    if (updateErr) console.log('WARN: mind_url update failed:', updateErr.message)

    // Upload manifest if provided by compile-local.js
    const manifestPath = `customers/${slug}/targets-manifest.json`
    if (req.body?.manifest) {
      const manifestBuf = Buffer.from(req.body.manifest)
      const { error: mErr } = await supabase.storage.from('minds')
        .upload(manifestPath, manifestBuf, { contentType: 'application/json', upsert: true })
      if (mErr) console.log('WARN: manifest upload failed:', mErr.message)
      else console.log('Manifest uploaded OK')
    } else {
      // Fallback: generate manifest from current artwork order in DB
      const { data: aws } = await supabase.from('artworks').select('id')
        .eq('customer_id', customer.id).order('created_at', { ascending: true })
      if (aws?.length) {
        const manifest = {}
        aws.forEach((a, i) => { manifest[String(i)] = a.id })
        const manifestBuf = Buffer.from(JSON.stringify(manifest))
        const { error: mErr } = await supabase.storage.from('minds')
          .upload(manifestPath, manifestBuf, { contentType: 'application/json', upsert: true })
        if (mErr) console.log('WARN: manifest upload failed:', mErr.message)
        else console.log('Manifest generated + uploaded:', JSON.stringify(manifest))
      }
    }

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

// ── Ideas API ─────────────────────────────────────────────────────────────────

app.get('/api/ideas/categories', async (req, res) => {
  const { data, error } = await supabase
    .from('idea_categories')
    .select('name')
    .order('created_at', { ascending: true })
  if (error) {
    console.error('[Categories] GET error:', error.code, error.message)
    return res.status(500).json({ error: error.message })
  }
  console.log('[Categories] GET returned', data.length, 'categories')
  res.json({ categories: data.map(r => r.name) })
})

app.post('/api/ideas/categories', async (req, res) => {
  console.log('[Categories] POST body:', req.body)
  const name = (req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: 'Name required' })
  const { data, error } = await supabase
    .from('idea_categories')
    .insert({ name })
    .select('name')
    .single()
  if (error) {
    console.error('[Categories] insert error:', error.code, error.message)
    if (error.code === '23505') return res.status(409).json({ error: 'Category already exists' })
    return res.status(500).json({ error: error.message })
  }
  console.log('[Categories] created:', data.name)
  res.json({ category: data.name })
})

app.post('/api/ideas/import', express.json(), async (req, res) => {
  const { entries } = req.body
  if (!Array.isArray(entries) || !entries.length)
    return res.status(400).json({ error: 'No entries provided' })

  const rows = entries
    .filter(e => e.title && e.category)
    .map(e => ({ title: e.title, category: e.category, notes: e.notes || null, file_url: null, file_type: null }))

  if (!rows.length) return res.status(400).json({ error: 'No valid entries found' })

  const { data, error } = await supabase.from('ideas').insert(rows).select()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ imported: data.length })
})

app.get('/api/ideas/files/all', async (req, res) => {
  const { data, error } = await supabase
    .from('idea_files')
    .select('*')
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ files: await withSignedUrlsForFiles(data || []) })
})

app.get('/api/ideas', async (req, res) => {
  const { data, error } = await supabase
    .from('ideas')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ideas: await withSignedUrls(data) })
})

app.get('/api/ideas/trash', async (req, res) => {
  const { data, error } = await supabase
    .from('ideas')
    .select('*')
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ideas: await withSignedUrls(data) })
})

app.post('/api/ideas', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'files', maxCount: 20 }]), async (req, res) => {
  const { title, category, notes, youtube_url, instagram_url } = req.body
  if (!title || !category) return res.status(400).json({ error: 'title and category required' })

  let file_url = null, file_type = null

  const primaryFile = req.files?.file?.[0]
  const extraFiles  = req.files?.files || []

  if (primaryFile) {
    const ext = (primaryFile.originalname.split('.').pop() || 'bin').toLowerCase()
    const storagePath = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error: upErr } = await supabase.storage
      .from(IDEAS_BUCKET)
      .upload(storagePath, primaryFile.buffer, { contentType: primaryFile.mimetype, cacheControl: '3600', upsert: false })
    if (upErr) return res.status(500).json({ error: 'Upload failed: ' + upErr.message })
    file_url  = storagePath
    file_type = primaryFile.mimetype.startsWith('video/') ? 'video' : 'image'
  } else if (youtube_url) {
    file_url  = youtube_url
    file_type = 'youtube'
  } else if (instagram_url) {
    file_url  = instagram_url
    file_type = 'instagram'
  }

  const { data, error } = await supabase
    .from('ideas')
    .insert({ title, category, notes: notes || null, file_url, file_type })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })

  // Upload extra gallery files
  const galleryFiles = []
  for (let i = 0; i < extraFiles.length; i++) {
    const f = extraFiles[i]
    const ext = (f.originalname.split('.').pop() || 'bin').toLowerCase()
    const sp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error: upErr } = await supabase.storage.from(IDEAS_BUCKET).upload(sp, f.buffer, { contentType: f.mimetype, cacheControl: '3600', upsert: false })
    if (!upErr) galleryFiles.push({ idea_id: data.id, file_url: sp, file_type: f.mimetype.startsWith('video/') ? 'video' : 'image', position: i })
  }
  let signedGalleryFiles = []
  if (galleryFiles.length) {
    const { data: inserted } = await supabase.from('idea_files').insert(galleryFiles).select()
    signedGalleryFiles = await withSignedUrlsForFiles(inserted || [])
  }

  const [ideaWithUrl] = await withSignedUrls([data])
  res.json({ idea: ideaWithUrl, files: signedGalleryFiles })
})

app.put('/api/ideas/:id', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'files', maxCount: 20 }]), async (req, res) => {
  const { id } = req.params
  const { title, category, notes, remove_file, youtube_url, instagram_url } = req.body
  if (!title || !category) return res.status(400).json({ error: 'title and category required' })

  const { data: existing, error: fetchErr } = await supabase
    .from('ideas').select('file_url, file_type').eq('id', id).single()
  if (fetchErr) return res.status(404).json({ error: 'Not found' })

  let file_url  = existing.file_url
  let file_type = existing.file_type

  const primaryFile = req.files?.file?.[0]
  const extraFiles  = req.files?.files || []

  if (primaryFile) {
    // Delete old file then upload replacement
    if (existing.file_url) {
      const oldPath = ideasFilePath(existing.file_url)
      if (oldPath) await supabase.storage.from(IDEAS_BUCKET).remove([oldPath]).catch(() => {})
    }
    const ext = (primaryFile.originalname.split('.').pop() || 'bin').toLowerCase()
    const storagePath = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error: upErr } = await supabase.storage
      .from(IDEAS_BUCKET)
      .upload(storagePath, primaryFile.buffer, {
        contentType: primaryFile.mimetype,
        cacheControl: '3600',
        upsert: false,
      })
    if (upErr) return res.status(500).json({ error: 'Upload failed: ' + upErr.message })
    file_url  = storagePath
    file_type = primaryFile.mimetype.startsWith('video/') ? 'video' : 'image'
  } else if (youtube_url) {
    if (existing.file_url && !EXTERNAL_TYPES.has(existing.file_type)) {
      const oldPath = ideasFilePath(existing.file_url)
      if (oldPath) await supabase.storage.from(IDEAS_BUCKET).remove([oldPath]).catch(() => {})
    }
    file_url  = youtube_url
    file_type = 'youtube'
  } else if (instagram_url) {
    if (existing.file_url && !EXTERNAL_TYPES.has(existing.file_type)) {
      const oldPath = ideasFilePath(existing.file_url)
      if (oldPath) await supabase.storage.from(IDEAS_BUCKET).remove([oldPath]).catch(() => {})
    }
    file_url  = instagram_url
    file_type = 'instagram'
  } else if (remove_file === 'true') {
    if (existing.file_url && !EXTERNAL_TYPES.has(existing.file_type)) {
      const oldPath = ideasFilePath(existing.file_url)
      if (oldPath) await supabase.storage.from(IDEAS_BUCKET).remove([oldPath]).catch(() => {})
    }
    file_url  = null
    file_type = null
  }

  const { data, error } = await supabase
    .from('ideas')
    .update({ title, category, notes: notes || null, file_url, file_type })
    .eq('id', id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })

  // Handle gallery file deletions
  let deleteIds = []
  try { deleteIds = JSON.parse(req.body.delete_file_ids || '[]') } catch {}
  for (const fid of deleteIds) {
    const { data: row } = await supabase.from('idea_files').select('file_url').eq('id', fid).single()
    if (row?.file_url) { const p = ideasFilePath(row.file_url); if (p) await supabase.storage.from(IDEAS_BUCKET).remove([p]).catch(() => {}) }
    await supabase.from('idea_files').delete().eq('id', fid)
  }

  // Upload extra gallery files
  const galleryFiles = []
  for (let i = 0; i < extraFiles.length; i++) {
    const f = extraFiles[i]
    const ext = (f.originalname.split('.').pop() || 'bin').toLowerCase()
    const sp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error: upErr } = await supabase.storage.from(IDEAS_BUCKET).upload(sp, f.buffer, { contentType: f.mimetype, cacheControl: '3600', upsert: false })
    if (!upErr) galleryFiles.push({ idea_id: id, file_url: sp, file_type: f.mimetype.startsWith('video/') ? 'video' : 'image', position: i })
  }
  let signedGalleryFiles = []
  if (galleryFiles.length) {
    const { data: inserted } = await supabase.from('idea_files').insert(galleryFiles).select()
    signedGalleryFiles = await withSignedUrlsForFiles(inserted || [])
  }

  const [ideaWithUrl] = await withSignedUrls([data])
  res.json({ idea: ideaWithUrl, files: signedGalleryFiles })
})

app.patch('/api/ideas/:id/trash', async (req, res) => {
  const { data, error } = await supabase
    .from('ideas').update({ deleted_at: new Date().toISOString() })
    .eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ idea: data })
})

app.patch('/api/ideas/:id/restore', async (req, res) => {
  const { data, error } = await supabase
    .from('ideas').update({ deleted_at: null })
    .eq('id', req.params.id).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ idea: data })
})

app.delete('/api/ideas/trash', async (req, res) => {
  const { data: trashed } = await supabase.from('ideas').select('file_url').not('deleted_at', 'is', null)
  const filePaths = (trashed || []).filter(i => i.file_url).map(i => ideasFilePath(i.file_url)).filter(Boolean)
  if (filePaths.length) await supabase.storage.from(IDEAS_BUCKET).remove(filePaths).catch(() => {})
  const { error } = await supabase.from('ideas').delete().not('deleted_at', 'is', null)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

app.delete('/api/ideas/:id/files/:fileId', async (req, res) => {
  const { data: row, error: fetchErr } = await supabase
    .from('idea_files').select('file_url').eq('id', req.params.fileId).single()
  if (fetchErr) return res.status(404).json({ error: 'Not found' })
  if (row.file_url) {
    const p = ideasFilePath(row.file_url)
    if (p) await supabase.storage.from(IDEAS_BUCKET).remove([p]).catch(() => {})
  }
  const { error } = await supabase.from('idea_files').delete().eq('id', req.params.fileId)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

app.delete('/api/ideas/:id', async (req, res) => {
  const { data: idea, error: fetchErr } = await supabase
    .from('ideas')
    .select('file_url')
    .eq('id', req.params.id)
    .single()

  if (fetchErr) return res.status(404).json({ error: 'Not found' })

  if (idea.file_url) {
    const filePath = ideasFilePath(idea.file_url)
    if (filePath) await supabase.storage.from(IDEAS_BUCKET).remove([filePath]).catch(() => {})
  }

  const { error } = await supabase.from('ideas').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

app.patch('/api/ideas/:id/favourite', async (req, res) => {
  const { is_favourite } = req.body
  if (typeof is_favourite !== 'boolean') return res.status(400).json({ error: 'is_favourite (boolean) required' })
  const { data, error } = await supabase
    .from('ideas')
    .update({ is_favourite })
    .eq('id', req.params.id)
    .select('id, is_favourite')
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json({ idea: data })
})

// POST /api/ideas/extract  — server-side Anthropic call (keeps API key secure)
app.post('/api/ideas/extract', async (req, res) => {
  console.log('\n━━━ /api/ideas/extract ━━━')

  const { text, categories: cats } = req.body
  console.log('[Extract] categories:', cats)
  console.log('[Extract] text length:', text?.length ?? 0)
  console.log('[Extract] text preview:', text?.slice(0, 120)?.replace(/\n/g, ' '))

  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' })
  if (!Array.isArray(cats) || !cats.length) return res.status(400).json({ error: 'categories required' })

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  console.log('[Extract] ANTHROPIC_API_KEY set:', !!ANTHROPIC_API_KEY)
  console.log('[Extract] ANTHROPIC_API_KEY prefix:', ANTHROPIC_API_KEY ? ANTHROPIC_API_KEY.slice(0, 10) + '…' : '(none)')
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' })

  const systemPrompt = `You are an idea extraction assistant. Read the following conversation or text and identify the most valuable insights, recommendations, ideas and action points. Return ONLY a JSON array with no markdown, no backticks, no preamble. Each item should have: title (short, max 8 words), category (must be one of the provided categories), notes (the key insight, kept close to original wording where possible). Extract between 3-15 ideas depending on content length.

Available categories: ${cats.join(', ')}`

  const requestBody = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: text.trim() }],
  }
  console.log('[Extract] → Anthropic model:', requestBody.model)
  console.log('[Extract] → system prompt length:', systemPrompt.length)
  console.log('[Extract] → user message length:', requestBody.messages[0].content.length)

  let apiRes
  try {
    console.log('[Extract] Calling Anthropic API…')
    apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
    })
  } catch (err) {
    console.error('[Extract] Network error:', err.message)
    return res.status(502).json({ error: 'Failed to reach Anthropic API: ' + err.message })
  }

  console.log('[Extract] Anthropic HTTP status:', apiRes.status, apiRes.statusText)

  if (!apiRes.ok) {
    const errText = await apiRes.text().catch(() => apiRes.statusText)
    console.error('[Extract] Anthropic error body:', errText)
    return res.status(502).json({ error: `Anthropic API error ${apiRes.status}: ${errText}` })
  }

  const data = await apiRes.json()
  console.log('[Extract] Response stop_reason:', data.stop_reason)
  console.log('[Extract] Response usage:', JSON.stringify(data.usage))
  const content = (data.content?.[0]?.text || '').trim()
  console.log('[Extract] Raw content length:', content.length)
  console.log('[Extract] Raw content preview:', content.slice(0, 300))

  let ideas
  try {
    ideas = JSON.parse(content)
    if (!Array.isArray(ideas)) throw new Error('response was not a JSON array')
    console.log('[Extract] Parsed OK —', ideas.length, 'ideas')
  } catch (e) {
    console.error('[Extract] JSON parse failed:', e.message)
    console.error('[Extract] Full raw content:\n', content)
    return res.status(502).json({ error: 'Failed to parse AI response', raw: content.slice(0, 500) })
  }

  res.json({ ideas })
})

// ── Smart Folders API ────────────────────────────────────────────────────────

app.get('/api/smart-folders', async (req, res) => {
  const [{ data: folders, error: fErr }, { data: items, error: iErr }] = await Promise.all([
    supabase.from('smart_folders').select('id, name, created_at').order('created_at', { ascending: true }),
    supabase.from('smart_folder_items').select('folder_id, idea_id'),
  ])
  if (fErr) return res.status(500).json({ error: fErr.message })
  if (iErr) return res.status(500).json({ error: iErr.message })
  res.json({ folders: folders || [], items: items || [] })
})

app.post('/api/smart-folders', async (req, res) => {
  const { name, ideaIds = [] } = req.body
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' })
  const { data: folder, error: fErr } = await supabase
    .from('smart_folders').insert({ name: name.trim() }).select().single()
  if (fErr) return res.status(500).json({ error: fErr.message })
  if (ideaIds.length) {
    const rows = ideaIds.map(idea_id => ({ folder_id: folder.id, idea_id }))
    const { error: iErr } = await supabase.from('smart_folder_items').insert(rows)
    if (iErr) console.warn('[SmartFolders] item insert warning:', iErr.message)
  }
  res.json({ folder })
})

app.delete('/api/smart-folders/:id', async (req, res) => {
  const { error } = await supabase.from('smart_folders').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

app.post('/api/smart-folders/:id/items', async (req, res) => {
  const { id } = req.params
  const { ideaIds = [] } = req.body
  if (!ideaIds.length) return res.status(400).json({ error: 'ideaIds required' })
  const rows = ideaIds.map(idea_id => ({ folder_id: id, idea_id }))
  const { error } = await supabase.from('smart_folder_items').upsert(rows, { onConflict: 'folder_id,idea_id' })
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// ── Static / Admin page ───────────────────────────────────────────────────────

app.use('/public', express.static(path.join(__dirname, 'public')))

app.get('/olly/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
})

app.get('/olly/ideas', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ideas.html'))
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
  console.log(`Ideas:   http://localhost:${PORT}/olly/ideas`)
  console.log(`═══════════════════════════════════`)
  console.log('Initialising Supabase storage...')
  await initBuckets()
  console.log('Ready.\n')
})
