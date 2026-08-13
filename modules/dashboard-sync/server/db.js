'use strict'

const { MongoClient } = require('mongodb')

const DEFAULT_URI = 'mongodb://localhost:27017/dashboard-sync-poc'

let _client = null
let _db = null

async function connect(uri) {
  if (_client) return _db
  const connUri = uri || DEFAULT_URI
  _client = new MongoClient(connUri)
  await _client.connect()
  _db = _client.db()
  return _db
}

async function disconnect() {
  if (_client) {
    await _client.close()
    _client = null
    _db = null
  }
}

function getCollection(name) {
  if (!_db) throw new Error('MongoDB not connected — call connect() first')
  return _db.collection(name)
}

async function upsertMany(collectionName, docs, keyField = 'key') {
  const col = getCollection(collectionName)
  let upserted = 0
  let modified = 0
  for (const doc of docs) {
    const result = await col.updateOne(
      { [keyField]: doc[keyField] },
      { $set: doc },
      { upsert: true }
    )
    if (result.upsertedCount) upserted++
    else if (result.modifiedCount) modified++
  }
  return { upserted, modified, total: docs.length }
}

function isConnected() {
  return _client !== null && _db !== null
}

module.exports = { connect, disconnect, getCollection, upsertMany, isConnected }
