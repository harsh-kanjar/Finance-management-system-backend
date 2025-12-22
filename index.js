const http = require("http");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const d3 = require("d3-dsv"); // npm install d3-dsv
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
            // ---------------- AUTH ----------------
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

            let username = decoded.username;
            if (typeof username === "object" && username !== null) username = username.username;
            if (typeof username !== "string") {
                console.error("BAD TOKEN PAYLOAD:", decoded);
                res.writeHead(403);
                return res.end("Invalid token payload");
            }

            // ---------------- REQUEST BODY ----------------
            const data = await parseBody(req);
            const amount = Number(data.amount);
            const type = String(data.type || "debit").toLowerCase();
            let category = data.category ? String(data.category).toLowerCase() : "";
            const note = data.note ? String(data.note) : "";

            if (isNaN(amount) || amount <= 0) {
                res.writeHead(400);
                return res.end("Invalid amount");
            }
            if (!["credit", "debit"].includes(type)) {
                res.writeHead(400);
                return res.end("Invalid transaction type");
            }

            // ---------------- DATE ----------------
            const now = new Date();
            const day = String(now.getDate());
            const month = String(now.getMonth() + 1);
            const year = String(now.getFullYear());

            // ---------------- FILE PATHS ----------------
            const balanceFile = path.join(TXN_DIR, `balance-${username}.json`);
            const monthlyFile = path.join(TXN_DIR, `transactions-${username}-${month}-${year}.json`);

            // ---------------- LOAD BALANCE ----------------
            let balanceData = { info: { balance: 0, savings: 0 }, track: {} };
            if (fs.existsSync(balanceFile)) {
                balanceData = JSON.parse(fs.readFileSync(balanceFile, "utf8"));
            } else {
                balanceData.track[year] = {
                    [month]: { savings: 0, expenses: 0, investments: 0, home_essentials: 0, lend: 0, untracked_cashflow: 0, income: 0 }
                };
            }

            // ---------------- LOAD MONTHLY FILE ----------------
            let monthlyStore = {};
            if (fs.existsSync(monthlyFile)) {
                monthlyStore = JSON.parse(fs.readFileSync(monthlyFile, "utf8"));
            }

            // ---------------- CALCULATE LAST BALANCE ----------------
            const allDates = Object.keys(monthlyStore).map(d => Number(d)).sort((a, b) => a - b);
            const lastBalance = allDates.length > 0 ? monthlyStore[allDates[allDates.length - 1]].balance || balanceData.info.balance : balanceData.info.balance;
            const newBalance = type === "credit" ? lastBalance + amount : lastBalance - amount;

            // ---------------- INIT TODAY ----------------
            if (!monthlyStore[day]) monthlyStore[day] = { balance: lastBalance };

            // ---------------- TRANSACTION ID ----------------
            const txCount = Object.keys(monthlyStore[day]).filter(k => k.startsWith("t")).length;
            const txId = `t${txCount}`;

            // ---------------- SAVE TRANSACTION ----------------
            monthlyStore[day][txId] = { amount, type, ...(category && { category }), ...(note && { note }) };
            monthlyStore[day].balance = newBalance;
            fs.writeFileSync(monthlyFile, JSON.stringify(monthlyStore, null, 2));

            // ---------------- UPDATE BALANCE FILE ----------------
            balanceData.info.balance = newBalance;
            if (!balanceData.track[year]) balanceData.track[year] = {};
            if (!balanceData.track[year][month]) {
                balanceData.track[year][month] = { savings: 0, expenses: 0, investments: 0, home_essentials: 0, lend: 0, untracked_cashflow: 0, income: 0 };
            }

            // ---------------- TRACK CATEGORIES ----------------
            switch (category) {
                case "expense":
                    balanceData.track[year][month].expenses += amount;
                    break;
                case "home essentials":
                    balanceData.track[year][month].home_essentials += amount;
                    break;
                case "health":
                    balanceData.track[year][month].investments += amount;
                    break;
                case "lend":
                    balanceData.track[year][month].lend += amount;
                    break;
                case "savings":
                    balanceData.track[year][month].savings += amount;
                    break;
                case "income":
                    balanceData.track[year][month].income += amount;
                    break;
                default:
                    balanceData.track[year][month].untracked_cashflow += amount;
            }

            fs.writeFileSync(balanceFile, JSON.stringify(balanceData, null, 2));
            res.end("Transaction added successfully");

        } catch (err) {
            console.error("ADD RECORD ERROR:", err);
            res.writeHead(500);
            res.end("Server error");
        }
    }


    else if (req.url === "/getbalance" && req.method === "GET") {
        try {
            // ---------------- AUTH ----------------
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

            let username = decoded.username;
            if (typeof username === "object" && username !== null) {
                username = username.username;
            }
            if (typeof username !== "string") {
                res.writeHead(403);
                return res.end("Invalid token payload");
            }

            // ---------------- DATE ----------------
            const now = new Date();
            const year = String(now.getFullYear());
            const month = String(now.getMonth() + 1).padStart(2, "0");

            // ---------------- FILE PATH ----------------
            const balanceFile = path.join(TXN_DIR, `balance-${username}.json`);

            if (!fs.existsSync(balanceFile)) {
                res.writeHead(404);
                return res.end("Balance file not found");
            }

            const balanceData = JSON.parse(fs.readFileSync(balanceFile, "utf8"));

            // ---------------- EXTRACT REQUIRED DATA ----------------
            const response = {
                balance: balanceData.info?.balance || 0,
                savings: balanceData.info?.savings || 0,
                monthData:
                    balanceData.track?.[year]?.[month] || {
                        savings: 0,
                        expenses: 0,
                        investments: 0,
                        home_essentials: 0,
                        lend: 0,
                        untracked_cashflow: 0,
                        income: 0
                    }
            };

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response, null, 2));

        } catch (err) {
            console.error("GET BALANCE ERROR:", err);
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

            let username = decoded.username;
            if (typeof username === "object" && username !== null) {
                username = username.username;
            }
            if (typeof username !== "string") {
                res.writeHead(403);
                return res.end("Invalid token payload");
            }

            // 📦 BODY (ONLY REQUIRED FIELDS)
            const data = await parseBody(req);

            if (!data["Fund Name"] || !data["NAV (INR)"]) {
                res.writeHead(400);
                return res.end("Fund Name and NAV are required");
            }

            const nav = Number(data["NAV (INR)"]);
            if (isNaN(nav) || nav <= 0) {
                res.writeHead(400);
                return res.end("Invalid NAV");
            }

            // 📁 LOAD exp-sip.json
            const EXP_SIP_FILE = path.join(__dirname, "transactions", "exp-sip.json");
            const expSip = JSON.parse(fs.readFileSync(EXP_SIP_FILE, "utf8"));

            const fundKey = Object.keys(expSip.info).find(
                k => expSip.info[k].fund_name === data["Fund Name"]
            );

            if (!fundKey) {
                res.writeHead(404);
                return res.end("Fund not found in exp-sip.json");
            }

            const fund = expSip.info[fundKey];

            // 📅 DATE INFO
            const now = new Date();
            const year = now.getFullYear().toString();
            const month = (now.getMonth() + 1).toString(); // 1-12

            // 💰 AMOUNT FROM JSON
            const amount = Number(fund.amount?.[year]?.amount || 0);
            if (amount <= 0) {
                res.writeHead(400);
                return res.end("Invalid SIP amount in exp-sip.json");
            }

            // 📐 CALCULATE UNITS
            const newUnits = amount / nav;
            const previousUnits = Number(fund.total_units || 0);
            const updatedTotalUnits = previousUnits + newUnits;

            // 📝 UPDATE NAV ENTRY (YEAR → MONTH)
            if (!fund.nav) fund.nav = {};
            if (!fund.nav[year]) fund.nav[year] = {};
            fund.nav[year][month] = nav;

            // 🔁 UPDATE TOTAL UNITS
            fund.total_units = Number(updatedTotalUnits.toFixed(4));

            // 💾 SAVE BACK TO JSON
            fs.writeFileSync(EXP_SIP_FILE, JSON.stringify(expSip, null, 4));

            // 📁 FILE SETUP (TSV)
            const sipFile = path.join(TXN_DIR, `sip-${username}-${year}.tsv`);
            const txnFile = path.join(TXN_DIR, `transactions-${username}-${year}.tsv`);

            const sipHeader =
                "Date\tFund Name\tCap Name\tInvestment Type\tAmount\tUnits Purchased\tTotal Units\tNAV (INR)\tPayment Method\tBalance After Investment (INR)\tBalance After Transaction\tNotes\tCurrent Value (INR)\tGrowth\tTransaction ID\n";

            if (!fs.existsSync(sipFile)) fs.writeFileSync(sipFile, sipHeader);

            const transactionId = `${getToday()}-${fund.scheme_code}-${Date.now()}`;

            // 🧾 SIP ENTRY
            const sipRow = [
                getToday(),
                fund.fund_name,
                fund.scheme_category,
                "SIP",
                amount,
                newUnits.toFixed(4),
                fund.total_units.toFixed(4),
                nav,
                "Auto",
                amount,
                amount,
                "",
                (fund.total_units * nav).toFixed(2),
                "0.00",
                transactionId
            ].join("\t");

            fs.appendFileSync(sipFile, sipRow + "\n");

            // 🔥 EXPENSE ENTRY
            let lastBalance = 0;

            if (!fs.existsSync(txnFile)) {
                fs.writeFileSync(
                    txnFile,
                    "Date\tCategory\tDescription\tPayment method\tAmount (INR)\tType\tBalance after spend (INR)\tNotes\tTransaction ID\tLoan ID\tIs Pocketmoney Transaction\n"
                );
            } else {
                const content = fs.readFileSync(txnFile, "utf8").trim();
                if (content) {
                    const lines = content.split("\n");
                    lastBalance = Number(lines[lines.length - 1].split("\t")[6]) || 0;
                }
            }

            const newBalance = lastBalance - amount;

            const expenseRow = [
                getToday(),
                "Investment",
                `SIP - ${fund.fund_name}`,
                "Auto",
                amount,
                "expense",
                newBalance,
                "",
                `${transactionId}-EXP`,
                "",
                "false"
            ].join("\t");

            fs.appendFileSync(txnFile, expenseRow + "\n");

            res.end("SIP added, NAV & total_units updated in exp-sip.json");
        } catch (err) {
            console.error(err);
            res.writeHead(500);
            res.end("Server error");
        }
    }

    else if (req.url === "/addnewsip" && req.method === "POST") {
        try {
            const auth = req.headers.authorization;
            if (!auth) return res.end("Unauthorized");

            const data = await parseBody(req);

            if (!data.fund_name || !data.scheme_category || !data.amount) {
                res.writeHead(400);
                return res.end("Missing required fields");
            }

            const EXP_SIP_FILE = path.join(__dirname, "transactions", "exp-sip.json");
            const json = JSON.parse(fs.readFileSync(EXP_SIP_FILE, "utf8"));

            const schemeCode =
                data.scheme_code ||
                data.fund_name.replace(/[^A-Z]/gi, "").substring(0, 6).toUpperCase() +
                "-" +
                Date.now().toString().slice(-3);

            if (json.info[schemeCode]) {
                res.writeHead(409);
                return res.end("Fund already exists");
            }

            const year = new Date().getFullYear();

            json.info[schemeCode] = {
                scheme_code: schemeCode,
                start_date: getToday().split("-").reverse().join(""),
                fund_house: data.fund_house || "",
                fund_name: data.fund_name,
                scheme_category: data.scheme_category,
                nav_day: data.nav_day || "10",
                total_units: 0,
                amount: {
                    [year]: { amount: Number(data.amount) }
                },
                nav: {}
            };

            fs.writeFileSync(EXP_SIP_FILE, JSON.stringify(json, null, 4));
            res.end("New SIP fund added successfully");
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

    else if (req.url === "/set1" && req.method === "GET") {
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
            const rawUser = decoded.username;
            const username =
                typeof rawUser === "string"
                    ? rawUser
                    : rawUser && typeof rawUser === "object"
                        ? rawUser.username
                        : null;

            if (!username) {
                res.writeHead(403);
                return res.end("Invalid token payload");
            }

            // 📁 FILE PATH
            const currentYear = new Date().getFullYear();
            const fileName = `transactions-${username}-${currentYear}.tsv`;
            const filePath = path.join(__dirname, "transactions", fileName);

            console.log("Serving TSV:", filePath);

            if (!fs.existsSync(filePath)) {
                res.writeHead(404);
                return res.end("Transactions file not found");
            }

            // 📄 READ TSV
            const tsvData = fs.readFileSync(filePath, "utf8");

            // 🛠 PARSE TSV to JSON
            const parsedData = d3.tsvParse(tsvData);

            // ✅ SEND JSON
            res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify(parsedData));

        } catch (err) {
            console.error("SET1 ERROR:", err);
            res.writeHead(500);
            res.end("Server error");
        }
    }

    else if (req.url === "/set2" && req.method === "GET") {
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
            const rawUser = decoded.username;
            const username =
                typeof rawUser === "string"
                    ? rawUser
                    : rawUser && typeof rawUser === "object"
                        ? rawUser.username
                        : null;

            if (!username) {
                res.writeHead(403);
                return res.end("Invalid token payload");
            }

            // 📁 FILE PATH
            const currentYear = new Date().getFullYear();
            const fileName = `spend-${username}-${currentYear}.tsv`;
            const filePath = path.join(__dirname, "transactions", fileName);

            console.log("Serving TSV:", filePath);

            if (!fs.existsSync(filePath)) {
                res.writeHead(404);
                return res.end("Transactions file not found");
            }

            // 📄 READ TSV
            const tsvData = fs.readFileSync(filePath, "utf8");

            // 🛠 PARSE TSV to JSON
            const parsedData = d3.tsvParse(tsvData);

            // ✅ SEND JSON
            res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify(parsedData));

        } catch (err) {
            console.error("SET1 ERROR:", err);
            res.writeHead(500);
            res.end("Server error");
        }
    }

    else if (req.url === "/set3" && req.method === "GET") {
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
            const rawUser = decoded.username;
            const username =
                typeof rawUser === "string"
                    ? rawUser
                    : rawUser && typeof rawUser === "object"
                        ? rawUser.username
                        : null;

            if (!username) {
                res.writeHead(403);
                return res.end("Invalid token payload");
            }

            // 📁 FILE PATH
            const fileName = `savings-${username}.tsv`;
            const filePath = path.join(__dirname, "transactions", fileName);

            console.log("Serving TSV:", filePath);

            if (!fs.existsSync(filePath)) {
                res.writeHead(404);
                return res.end("Transactions file not found");
            }

            // 📄 READ TSV
            const tsvData = fs.readFileSync(filePath, "utf8");

            // 🛠 PARSE TSV to JSON
            const parsedData = d3.tsvParse(tsvData);

            // ✅ SEND JSON
            res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify(parsedData));

        } catch (err) {
            console.error("SET1 ERROR:", err);
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