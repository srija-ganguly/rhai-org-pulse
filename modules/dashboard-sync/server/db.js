'use strict'

const mongoose = require('mongoose')

let _connection = null

async function connect(uri) {
  if (_connection) return _connection
  _connection = await mongoose.createConnection(uri)
  console.log('[dashboard-sync] Mongoose connected to', uri.replace(/\/\/[^@]+@/, '//<redacted>@'))
  return _connection
}

async function disconnect() {
  if (_connection) {
    await _connection.close()
    _connection = null
  }
}

function getCollection(name) {
  if (!_connection) throw new Error('MongoDB not connected — call connect() first')
  return _connection.db.collection(name)
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
  return _connection !== null && _connection.readyState === 1
}

function getConnection() {
  return _connection
}

module.exports = { connect, disconnect, getCollection, upsertMany, isConnected, getConnection }
