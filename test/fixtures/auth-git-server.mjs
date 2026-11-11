// Smart-HTTP git server over `git http-backend` that requires Basic auth. Prints its port, then serves.
// Usage: node auth-git-server.mjs <project-root> <user> <password>
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const [root, user, password] = process.argv.slice(2)
const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

const server = createServer((request, response) => {
  if (request.headers.authorization !== expected) {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' })
    response.end()
    return
  }
  const url = new URL(request.url ?? '/', 'http://localhost')
  const backend = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      REMOTE_USER: user,
      REQUEST_METHOD: request.method ?? 'GET',
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: request.headers['content-type'] ?? '',
      HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
      GIT_PROTOCOL: request.headers['git-protocol'] ?? '',
    },
  })
  request.pipe(backend.stdin)
  let buffer = Buffer.alloc(0)
  let headersSent = false
  backend.stdout.on('data', (chunk) => {
    if (headersSent) return void response.write(chunk)
    buffer = Buffer.concat([buffer, chunk])
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    let status = 200
    const headers = {}
    for (const line of buffer.subarray(0, end).toString().split('\r\n')) {
      const [name, ...rest] = line.split(':')
      const value = rest.join(':').trim()
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10)
      else headers[name] = value
    }
    response.writeHead(status, headers)
    headersSent = true
    response.write(buffer.subarray(end + 4))
  })
  backend.on('close', () => response.end())
})
server.listen(0, '127.0.0.1', () => console.log(server.address().port))
