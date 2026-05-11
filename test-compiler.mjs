import { fork } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

console.log('Forking compiler.mjs…')
const child = fork(path.join(__dirname, 'compiler.mjs'), [], {
  stdio: ['pipe', 'inherit', 'inherit', 'ipc']
})

const timer = setTimeout(() => {
  console.log('TIMEOUT — no ready signal in 30s')
  child.kill()
  process.exit(1)
}, 30000)

child.on('message', (msg) => {
  console.log('IPC message:', JSON.stringify(msg))
  if (msg.type === 'ready') {
    console.log('✓ compiler.mjs is up and sent ready')
    clearTimeout(timer)
    child.kill()
    process.exit(0)
  }
  if (msg.type === 'error') {
    console.error('✗ compiler error:', msg.message)
    clearTimeout(timer)
    child.kill()
    process.exit(1)
  }
})

child.on('exit', (code) => console.log('child exited, code:', code))
child.on('error', (err) => { console.error('fork error:', err.message); process.exit(1) })
