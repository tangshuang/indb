const express = require("express")
const app = express()
const open = require('open')

app.get("*", express.static(__dirname))

const server = app.listen(8001, () => {
  open('http://localhost:8001/examples/test.html')
})

setTimeout(() => {
  server.close()
}, 2000)
