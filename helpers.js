import crypto from "crypto";
import jwt from "jsonwebtoken";
/* ------------------ HELPERS ------------------ */
const SECRET_KEY = "s5@ti7^g4b2r287h2982fnue#$@D223e"; 
const AUTH_SECRET_KEY = "dnuwern3u4n239fj934j3@f@$R2f3"

function parseBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => resolve(JSON.parse(body || "{}")));
    });
}

function encryptPassword(password) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
        "aes-256-cbc",
        crypto.createHash("sha256").update(SECRET_KEY).digest(),
        iv
    );
    let encrypted = cipher.update(password, "utf8", "hex");
    encrypted += cipher.final("hex");
    return { encrypted, iv: iv.toString("hex") };
}

function decryptPassword(encrypted, iv) {
    const decipher = crypto.createDecipheriv(
        "aes-256-cbc",
        crypto.createHash("sha256").update(SECRET_KEY).digest(),
        Buffer.from(iv, "hex")
    );
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
}

function generateJWT(username) {
  return jwt.sign(
    { username },          // payload
    AUTH_SECRET_KEY
  );
}


function verifyJWT(token) {
  try {
    return jwt.verify(token, AUTH_SECRET_KEY);
  } catch (err) {
    return null;
  }
}


function getToday() {
    const d = new Date();
    return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`;
}

function generateTransactionId(data, count) {
    return `${new Date().getFullYear()}${data.Date.replace(/-/g, "")}-${data.Category.substring(0, 3).toUpperCase()}-${String(count).padStart(4, "0")}`;
}


export {
    parseBody,
    encryptPassword,
    decryptPassword,
    generateJWT,
    verifyJWT,
    getToday,
    generateTransactionId
};