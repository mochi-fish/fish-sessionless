// 一次性的测试 CA + api.deepseek.com 的叶证书（转发器在 CONNECT 里用它终止 TLS；代理拷贝靠 network.caFile / NODE_EXTRA_CA_CERTS 认它）。
// CA 私钥签完就删，这张 CA 不能再签别的；有效期 7 天。只给这台机器上这次跑的代理拷贝用，不装进系统证书库。
// 用 openssl（不出网）：Windows 上缺省是 Git 自带的那个，别的系统用 PATH 里的；OPENSSL_EXE 可以换。用法：node fwd/make-test-ca.mjs <输出目录>  → ca.pem / leaf.pem / leaf.key
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OPENSSL = process.env.OPENSSL_EXE || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\ucrt64\\bin\\openssl.exe' : 'openssl')
const out = process.argv[2]
if (!out) { console.error('usage: make-test-ca.mjs <dir>'); process.exit(2) }
if (existsSync(join(out, 'leaf.pem'))) { console.error(`exists: ${out}`); process.exit(2) }
mkdirSync(out, { recursive: true })
const run = (...args) => {
  const r = spawnSync(OPENSSL, args, { cwd: out, windowsHide: true, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1', OPENSSL_CONF: '' } })
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr}`)
}
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '7', '-subj', `/CN=open-book-eval one-off test CA ${stamp}`,
  '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=api.deepseek.com')
writeFileSync(join(out, 'leaf.ext'), 'subjectAltName=DNS:api.deepseek.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
run('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '7', '-extfile', 'leaf.ext')
for (const f of ['ca.key', 'leaf.csr', 'leaf.ext', 'ca.srl']) rmSync(join(out, f), { force: true })
console.log(JSON.stringify({ ok: true, dir: out }))
