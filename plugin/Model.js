.pragma library

// Pure helpers for the Monzo panel. No QML types here so this file can be
// unit-tested with plain Node (strip the pragma line).

function parseSnapshot(text) {
  var empty = { status: "missing", error: "", updatedAt: "", attemptedAt: "", sinceDays: 7, accounts: [], pots: [], transactions: [] }
  var raw = String(text || "").trim()
  if (!raw) return empty
  try {
    var s = JSON.parse(raw)
    if (!s || s.version !== 1) return empty
    return {
      status: String(s.status || "error"),
      error: String(s.error || ""),
      updatedAt: String(s.updatedAt || ""),
      attemptedAt: String(s.attemptedAt || ""),
      sinceDays: Number(s.sinceDays) || 7,
      accounts: Array.isArray(s.accounts) ? s.accounts : [],
      pots: Array.isArray(s.pots) ? s.pots : [],
      transactions: Array.isArray(s.transactions) ? s.transactions : []
    }
  } catch (e) {
    return empty
  }
}

var SYMBOLS = { GBP: "£", EUR: "€", USD: "$" }

// 123456 -> "£1,234.56"; -350 -> "-£3.50"; signed=true adds "+" for credits.
function money(minor, currency, signed) {
  if (minor === null || minor === undefined || isNaN(Number(minor))) return "—"
  var n = Number(minor)
  var neg = n < 0
  var abs = Math.abs(n)
  var pounds = Math.floor(abs / 100)
  var pence = abs % 100
  var whole = String(pounds).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  var sym = SYMBOLS[currency] !== undefined ? SYMBOLS[currency] : (String(currency || "") + " ")
  var sign = neg ? "-" : (signed && n > 0 ? "+" : "")
  return sign + sym + whole + "." + (pence < 10 ? "0" : "") + pence
}

function pad2(n) { return (n < 10 ? "0" : "") + n }

var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function dayKey(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) }

function dayLabel(d, now) {
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  var that = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  var diff = Math.round((today - that) / 86400000)
  if (diff === 0) return "Today"
  if (diff === 1) return "Yesterday"
  return DAY_NAMES[d.getDay()] + " " + d.getDate() + " " + MONTH_NAMES[d.getMonth()]
}

function timeLabel(iso) {
  var d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes())
}

// Transactions (already newest-first) -> [{ label, total, items: [...] }] in local days.
// `total` is net spending for the day (debits only, excluding declined).
function groupByDay(transactions, now) {
  var groups = []
  var byKey = {}
  for (var i = 0; i < transactions.length; i++) {
    var t = transactions[i]
    var d = new Date(t.created)
    if (isNaN(d.getTime())) continue
    var key = dayKey(d)
    var g = byKey[key]
    if (!g) {
      g = { key: key, label: dayLabel(d, now || new Date()), spent: 0, items: [] }
      byKey[key] = g
      groups.push(g)
    }
    g.items.push(t)
    if (!t.declined && Number(t.amount) < 0) g.spent += Number(t.amount)
  }
  return groups
}

// "Updated 19:42" / "Updated yesterday 19:42" / "Never updated".
function updatedLabel(iso, now) {
  if (!iso) return "Never updated"
  var d = new Date(iso)
  if (isNaN(d.getTime())) return "Never updated"
  var label = dayLabel(d, now || new Date())
  return "Updated " + (label === "Today" ? "" : label.toLowerCase() + " ") + timeLabel(iso)
}

function accountByKind(accounts, kind) {
  for (var i = 0; i < accounts.length; i++) if (accounts[i].kind === kind) return accounts[i]
  return null
}

// Flex balances are negative (money owed); show them as a positive debt.
function accountAmount(account) {
  if (account.kind === "flex") {
    var owed = -Number(account.balance || 0)
    return owed > 0 ? money(owed, account.currency) + " owed" : "Nothing owed"
  }
  return money(account.balance, account.currency)
}
