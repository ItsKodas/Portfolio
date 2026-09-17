// Run after `docker compose restart mailserver`, to record that Postfix has picked up the certificate
// currently on disk. Until that happens mailops reports cert-reload-needed, because mailserver runs
// SSL_TYPE=manual and does not reliably notice the file changing: a renewal nobody restarted for means
// the certificate on the wire quietly expires while the file on disk looks healthy.
//
// This is a manual step on purpose. The alternative is giving this container the Docker socket so it can
// restart mailserver itself, which would hand the most privileged capability in the stack to the process
// that already holds a zone-edit token. A documented two-command step is the better trade.

import { loadConfig } from './config.ts'
import { acknowledgeCurrentCertificate } from './certs.ts'

const CERT_DIR = process.env.MAIL_CERT_DIR ?? '/mail-certs'

const config = loadConfig(process.env)
const notAfter = await acknowledgeCurrentCertificate(config, CERT_DIR)

if (notAfter) {
    console.log(`[mailops] acknowledged the certificate for ${config.mailHostname}, expiring ${notAfter.toISOString()}`)
} else {
    console.error(`[mailops] no certificate for ${config.mailHostname} on disk in ${CERT_DIR}, nothing to acknowledge`)
    process.exit(1)
}
