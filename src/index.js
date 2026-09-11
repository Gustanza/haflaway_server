require('dotenv').config()
const express = require('express')
const cors = require('cors')
const healthRoutes = require('./routes/health')
const cardsRoutes = require('./routes/cards')
const campaignsRoutes = require('./routes/campaigns')

const app = express()
app.use(cors())
app.use(express.json())

app.use(healthRoutes)
app.use(cardsRoutes)
app.use(campaignsRoutes)

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  console.log(`haflaway-card-server listening on port ${PORT}`)
})
