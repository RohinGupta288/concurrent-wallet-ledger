/**
 * Gives every request an ID (req.id) and returns it in the X-Request-Id
 * response header. The same ID appears in logs and error responses, so a
 * client-reported error can be matched to the server's log line.
 *
 * A caller-supplied X-Request-Id is reused only if it looks safe (short,
 * simple characters), so it cannot inject strange content into logs.
 */
const crypto = require("crypto")

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/

function requestId(req, res, next) {
    const incoming = req.get("X-Request-Id")
    req.id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID()
    res.set("X-Request-Id", req.id)
    next()
}

module.exports = requestId
