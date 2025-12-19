const http = require("http");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const {
    parseBody,
    encryptPassword,
    decryptPassword,
    generateJWT,
    verifyJWT,
    getToday,
    generateTransactionId
} = require("./helpers");

const PORT = 3000;

const USERS_FILE = path.join(__dirname, "users.tsv");
const TXN_DIR = path.join(__dirname, "transactions");

if (!fs.existsSync(TXN_DIR)) fs.mkdirSync(TXN_DIR);

/* ------------------ SERVER ------------------ */

const server = http.createServer(async (req, res) => {

    // -------------------------
    // CORS HEADERS
    // -------------------------
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:5173"); // allow all origins
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    ); // allowed methods
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
    ); // allow Authorization header

    // ✅ Handle preflight OPTIONS request
    if (req.method === "OPTIONS") {
        res.writeHead(200);
        return res.end();
    }
    /* ---------- SIGNUP ---------- */
    if (req.url === "/signup" && req.method === "POST") {
        const { username, password } = await parseBody(req);

        if (!username || !password) {
            res.writeHead(400);
            return res.end("Missing username or password");
        }

        // Create users file if not exists
        if (!fs.existsSync(USERS_FILE)) {
            fs.writeFileSync(USERS_FILE, "username\tpassword\tiv\n");
        }

        const users = fs.readFileSync(USERS_FILE, "utf8").split("\n");

        // ✅ CHECK UNIQUE USERNAME
        for (let i = 1; i < users.length; i++) {
            const [existingUsername] = users[i].split("\t");
            if (existingUsername === username) {
                res.writeHead(409);
                return res.end("Username already exists");
            }
        }

        // Encrypt password
        const { encrypted, iv } = encryptPassword(password);

        // Save user
        fs.appendFileSync(
            USERS_FILE,
            `${username}\t${encrypted}\t${iv}\n`
        );

        res.writeHead(201);
        res.end("Signup successful");
    }


    /* ---------- LOGIN ---------- */
    else if (req.url === "/login" && req.method === "POST") {
        const { username, password } = await parseBody(req);

        const users = fs.readFileSync(USERS_FILE, "utf8").split("\n");

        for (let i = 1; i < users.length; i++) {
            const [u, p, iv] = users[i].split("\t");
            if (u === username && decryptPassword(p, iv) === password) {
                const token = generateJWT({ username });
                return res.end(JSON.stringify({ token }));
            }
        }

        res.writeHead(401);
        res.end("Invalid credentials");
    }

    /* ---------- ADD RECORD ---------- */
    else if (req.url === "/addrecord" && req.method === "POST") {
        try {
            const auth = req.headers["authorization"];
            if (!auth || !auth.startsWith("Bearer ")) {
                res.writeHead(401);
                return res.end("Missing token");
            }

            const token = auth.split(" ")[1];
            const decoded = verifyJWT(token);

            if (!decoded) {
                res.writeHead(403);
                return res.end("Invalid token");
            }

            // 🔥 GUARANTEED STRING EXTRACTION
            let username = decoded.username;
            if (typeof username === "object" && username !== null) {
                username = username.username;
            }

            if (typeof username !== "string") {
                console.error("BAD TOKEN PAYLOAD:", decoded);
                res.writeHead(403);
                return res.end("Invalid token payload");
            }

            const data = await parseBody(req);
            const year = new Date().getFullYear();

            const fileName = `transactions-${username}-${year}.tsv`;
            const filePath = path.join(TXN_DIR, fileName);

            const header =
                "Date\tCategory\tDescription\tPayment method\tAmount (INR)\tType\tBalance after spend (INR)\tNotes\tTransaction ID\tLoan ID\tIs Pocketmoney Transaction\n";

            let lastBalance = 0;
            let lines = [];

            // 📄 If file exists → read last balance
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, "utf8").trim();
                if (content) {
                    lines = content.split("\n");
                    const lastLine = lines[lines.length - 1].split("\t");
                    lastBalance = Number(lastLine[6]) || 0; // Balance column index
                }
            } else {
                // 📄 Create file with header
                fs.writeFileSync(filePath, header);
            }

            // 🔢 Amount
            const amount = Number(data["Amount (INR)"]);
            if (isNaN(amount)) {
                res.writeHead(400);
                return res.end("Invalid amount");
            }

            // 🔄 Calculate balance
            let newBalance = lastBalance;

            const type = String(data.Type || "").toLowerCase();
            if (type === "income") {
                newBalance = lastBalance + amount;
            } else {
                // treat everything else as expense
                newBalance = lastBalance - amount;
            }

            // 🧾 Fill derived fields
            data.Date = getToday();
            data["Transaction ID"] = generateTransactionId(data, lines.length);
            data["Balance after spend (INR)"] = newBalance;

            const row = [
                data.Date,
                data.Category,
                data.Description,
                data["Payment method"],
                amount,
                data.Type,
                newBalance,
                data.Notes || "",
                data["Transaction ID"],
                data["Loan ID"] || "",
                data["Is Pocketmoney Transaction"] || "false"
            ].join("\t");

            fs.appendFileSync(filePath, row + "\n");

            res.end("Transaction added");
        } catch (err) {
            console.error(err);
            res.writeHead(500);
            res.end("Server error");
        }
    }

    else if (req.url === "/sip" && req.method === "POST") {
        try {
            // 🔐 AUTH
            const auth = req.headers["authorization"];
            if (!auth || !auth.startsWith("Bearer ")) {
                res.writeHead(401);
                return res.end("Missing token");
            }

            const decoded = verifyJWT(auth.split(" ")[1]);
            if (!decoded) {
                res.writeHead(403);
                return res.end("Invalid token");
            }

            // 👤 USERNAME
            let username = decoded.username;
            if (typeof username === "object" && username !== null) {
                username = username.username;
            }
            if (typeof username !== "string") {
                res.writeHead(403);
                return res.end("Invalid token payload");
            }

            // 📦 BODY
            const data = await parseBody(req);

            if (!data["Fund Name"]) {
                res.writeHead(400);
                return res.end("Fund Name is required");
            }

            const amount = Number(data.Amount);
            const unitsPurchased = Number(data["Units Purchased"]);
            const nav = Number(data["NAV (INR)"]);

            if (isNaN(amount) || isNaN(unitsPurchased) || isNaN(nav)) {
                res.writeHead(400);
                return res.end("Invalid numeric values");
            }

            // 📁 FILE SETUP
            const year = new Date().getFullYear();
            const sipFile = path.join(TXN_DIR, `sip-${username}-${year}.tsv`);
            const txnFile = path.join(TXN_DIR, `transactions-${username}-${year}.tsv`);
            const sipHeader =
                "Date\tFund Name\tCap Name\tInvestment Type\tAmount\tUnits Purchased\tTotal Units\tNAV (INR)\tPayment Method\tBalance After Investment (INR)\tBalance After Transaction\tNotes\tCurrent Value (INR)\tGrowth\tTransaction ID\n";

            // Ensure SIP file exists
            if (!fs.existsSync(sipFile)) fs.writeFileSync(sipFile, sipHeader);

            // 📊 CALCULATE TOTAL UNITS & INVESTMENT
            let lines = [];
            let lastTotalUnits = 0;
            let lastNav = 0;
            let lastTotalInvestment = 0;

            const sipContent = fs.readFileSync(sipFile, "utf8").trim();
            if (sipContent) {
                lines = sipContent.split("\n");
                for (let i = lines.length - 1; i >= 1; i--) {
                    const cols = lines[i].split("\t");
                    if (cols[1] === data["Fund Name"]) {
                        lastTotalUnits = Number(cols[6]) || 0;
                        lastNav = Number(cols[7]) || 0;
                        lastTotalInvestment = Number(cols[10]) || 0;
                        break;
                    }
                }
            }

            const newTotalUnits = lastTotalUnits + unitsPurchased;
            const newTotalInvestment = lastTotalInvestment + amount;
            const growth = lastNav > 0 ? ((nav - lastNav) / lastNav) * 100 : 0;
            const currentValue = newTotalInvestment + (newTotalInvestment * growth) / 100;

            const transactionId = `${getToday()}-${data["Fund Name"].replace(/[^A-Za-z]/g, "").substring(0, 3).toUpperCase()}-${lines.length + 1}`;

            const sipRow = [
                getToday(),
                data["Fund Name"],
                data["Cap Name"] || "",
                data["Investment Type"] || "SIP",
                amount,
                unitsPurchased,
                newTotalUnits,
                nav,
                data["Payment Method"] || "",
                amount,
                newTotalInvestment,
                data.Notes || "",
                currentValue.toFixed(2),
                growth.toFixed(2),
                transactionId
            ].join("\t");

            fs.appendFileSync(sipFile, sipRow + "\n");

            // 🔥 AUTO-EXPENSE ENTRY
            // Read last balance from transactions file
            let lastBalance = 0;
            if (!fs.existsSync(txnFile)) {
                const header =
                    "Date\tCategory\tDescription\tPayment method\tAmount (INR)\tType\tBalance after spend (INR)\tNotes\tTransaction ID\tLoan ID\tIs Pocketmoney Transaction\n";
                fs.writeFileSync(txnFile, header);
            } else {
                const txnContent = fs.readFileSync(txnFile, "utf8").trim();
                if (txnContent) {
                    const txnLines = txnContent.split("\n");
                    const lastLine = txnLines[txnLines.length - 1].split("\t");
                    lastBalance = Number(lastLine[6]) || 0;
                }
            }

            const newBalance = lastBalance - amount;
            const expenseRow = [
                getToday(),
                "Investment",
                `SIP - ${data["Fund Name"]}`,
                data["Payment Method"] || "",
                amount,
                "expense",
                newBalance,
                data.Notes || "",
                `${transactionId}-EXP`,
                "",
                "false"
            ].join("\t");

            fs.appendFileSync(txnFile, expenseRow + "\n");

            res.end("SIP transaction added & expense recorded successfully");
        } catch (err) {
            console.error(err);
            res.writeHead(500);
            res.end("Server error");
        }
    }


    else if (req.url === "/essentials" && req.method === "GET") {
        try {
            // 🔐 AUTH
            const auth = req.headers["authorization"];
            if (!auth || !auth.startsWith("Bearer ")) {
                res.writeHead(401);
                return res.end("Missing token");
            }

            const decoded = verifyJWT(auth.split(" ")[1]);
            if (!decoded) {
                res.writeHead(403);
                return res.end("Invalid token");
            }

            // 👤 USERNAME
            let username = decoded.username;
            if (typeof username === "object" && username !== null) {
                username = username.username;
            }
            if (typeof username !== "string") {
                res.writeHead(403);
                return res.end("Invalid token payload");
            }

            // 📁 FILE PATH
            const fileName = `sip-${username}.json`;
            console.log("ESSENTIALS FILE:", fileName);
            const filePath = path.join(TXN_DIR, fileName);

            // 🔄 READ FILE
            if (!fs.existsSync(filePath)) {
                res.writeHead(404);
                return res.end("Essentials file not found");
            }

            const content = fs.readFileSync(filePath, "utf8");
            const jsonData = JSON.parse(content);

            // ✅ SEND RESPONSE
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(jsonData));
        } catch (err) {
            console.error(err);
            res.writeHead(500);
            res.end("Server error");
        }
    }

    else {
        res.writeHead(404);
        res.end("Route not found");
    }
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});