require('dotenv').config()
const express = require('express')
const cors = require('cors')
const healthRoutes = require('./routes/health')
const cardsRoutes = require('./routes/cards')
const campaignsRoutes = require('./routes/campaigns')
const organizationsRoutes = require('./routes/organizations')

const app = express()
app.use(cors())
// TEMP: request logging to debug a "Failed to fetch" the SPA is hitting on
// the send route — remove once diagnosed.
app.use((req, res, next) => { console.log(`--> ${req.method} ${req.url}`); next() })
app.use(express.json())

app.use(healthRoutes)
app.use(cardsRoutes)
app.use(campaignsRoutes)
app.use(organizationsRoutes)

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  console.log(`haflaway-card-server listening on port ${PORT}`)
})
