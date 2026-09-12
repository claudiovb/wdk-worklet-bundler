import fs from 'fs'
/** Build a bare-pack style bundle: <N>\n<JSON>\n<DATA> */
export function createBundle (files: Record<string, string>): Buffer {
  const buffers: Buffer[] = []
  const fileMap: Record<string, { offset: number, length: number }> = {}
  let offset = 0

  for (const [filePath, content] of Object.entries(files)) {
    const buf = Buffer.from(content)
    fileMap[filePath] = { offset, length: buf.length }
    offset += buf.length
    buffers.push(buf)
  }

  const json = JSON.stringify({ files: fileMap })
  const N = json.length + 2
  return Buffer.concat([
    Buffer.from(N.toString() + '\n'),
    Buffer.from(json),
    Buffer.from('\n'),
    ...buffers
  ])
}

/** Parse a bundle back into per-file contents (mirrors the bundle format) */
export function readBundleFiles (bundlePath: string): Record<string, string> {
  return parseBundleFiles(fs.readFileSync(bundlePath))
}

export function parseBundleFiles (buf: Buffer): Record<string, string> {
  const nl = buf.indexOf(0x0a)
  const N = parseInt(buf.subarray(0, nl).toString(), 10)
  const headerStart = nl + 1
  const jsonEnd = headerStart + N - 2
  const header = JSON.parse(buf.subarray(headerStart, jsonEnd).toString()) as {
    files: Record<string, { offset: number, length: number }>
  }
  const dataStart = jsonEnd + 1

  const out: Record<string, string> = {}
  for (const [filePath, info] of Object.entries(header.files)) {
    out[filePath] = buf
      .subarray(dataStart + info.offset, dataStart + info.offset + info.length)
      .toString()
  }
  return out
}

export function wrapBundle (wrapper: 'cjs' | 'mjs' | 'json', raw: Buffer): Buffer {
  switch (wrapper) {
    case 'cjs':
      return Buffer.from(`module.exports = ${JSON.stringify(raw.toString('utf8'))}\n`)
    case 'mjs':
      return Buffer.from(`export default ${JSON.stringify(raw.toString('utf8'))}\n`)
    case 'json':
      return Buffer.from(`${JSON.stringify(raw.toString('utf8'))}\n`)
  }
}
