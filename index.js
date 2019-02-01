'use strict'
var pull = require('pull-stream')
var Write = require('pull-write')
var pl = require('pull-level')
var Obv = require('obv')
var Paramap = require('pull-paramap')
var ltgt = require('ltgt')
var explain = require('explain-error')
var charwise = require('charwise')
const debug = require('debug')('flumeview-level')
debug.enabled = true

module.exports = function (version, map) {
  debug('re-init')
  return function (log) {
    debug('re-start')
    var writer

    var META = '\x00', since = Obv()

    var closed, outdated

    let db = log.level({
      keyEncoding: charwise,
      valueEncoding: 'json',
      open: (cb) => {
        debug('opened')
        cb()
      }
    })

    function create() {
      debug('create()')
      if (closed === false) {
        debug('already created')
      }

      closed = false

      if (!log.level) {
        throw new Error('flumeview-level can only be used with a log that provides an instance of level')
      }
    }

    function close (cb) {
      debug('close()')
      if (closed === true) {
        debug('already closed')
        return cb()
      }

      closed = true
      //todo: move this bit into pull-write
      if (outdated) db.close(cb)
      else if(writer) writer.abort(function () { db.close(cb) })
      else if(!db) cb()
      else since.once(function () {
        db.close(cb)
      })
    }

    function destroy (cb) {
      db.createKeyStream().pipe(db.createDeleteStream()).on('end', cb)
    }

    setImmediate(function () {
      if(closed) {
        debug('somehow closed')
        return
      }
      create()
      db.get(META, {keyEncoding: 'utf8'}, function (err, value) {
        if(err) since.set(-1)
        else if(value.version === version)
          since.set(value.since)
        else {
          //version has changed, wipe db and start over.
          outdated = true
          destroy(function () {
            since.set(-1)
          })
        }
      })
    })

    return {
      since: since,
      methods: { get: 'async', read: 'source'},
      createSink: function (cb) {
       return writer = Write(function (batch, cb) {
          if(closed) return cb(new Error('database closed while index was building'))
          db.batch(batch, function (err) {
            if(err) return cb(err)
            since.set(batch[0].value.since)
            //callback to anyone waiting for this point.
            cb()
          })
        }, function reduce (batch, data) {
          if(data.sync) return batch
          var seq = data.seq

          if(!batch)
            batch = [{
              key: META,
              value: {version: version, since: seq},
              valueEncoding: 'json', keyEncoding:'utf8', type: 'put'
            }]

          //map must return an array (like flatmap) with zero or more values
          var indexed = map(data.value, data.seq)
          batch = batch.concat(indexed.map(function (key) { return { key: key, value: seq, type: 'put' }}))
          batch[0].value.since = Math.max(batch[0].value.since, seq)
          return batch
        }, 512, cb)
      },

      get: function (key, cb) {
        //wait until the log has been processed up to the current point.
        db.get(key, function (err, seq) {
          if(err && err.name === 'NotFoundError') return cb(err)
          if(err) cb(explain(err, 'flumeview-level.get: key not found:'+key))
          else
            log.get(seq, function (err, value) {
              if(err) cb(explain(err, 'flumeview-level.get: index for:'+key+'pointed at:'+seq+'but log error'))
              else cb(null, value)
            })
        })
      },
      read: function (opts) {
        var keys = opts.keys !== false
        var values = opts.values !== false
        var seqs = opts.seqs !== false
        opts.keys = true; opts.values = true
        //TODO: preserve whatever the user passed in on opts...

        var lower = ltgt.lowerBound(opts)
        if(lower == null) opts.gt = null

        function format (key, seq, value) {
          return (
            keys && values && seqs ? {key: key, seq: seq, value: value}
          : keys && values         ? {key: key, value: value}
          : keys && seqs           ? {key: key, seq: seq}
          : seqs && values         ? {seq: seq, value: value}
          : keys ? key : seqs ? seq : value
          )
        }

        return pull(
          pl.read(db, opts),
          pull.filter(function (op) {
            //this is an ugly hack! ); but it stops the index metadata appearing in the live stream
            return op.key !== META
          }),
          values
          ? Paramap(function (data, cb) {
              if(data.sync) return cb(null, data)
              log.get(data.value, function (err, value) {
                if(err) cb(explain(err, 'when trying to retrive:'+data.key+'at since:'+log.since.value))
                else cb(null, format(data.key, data.value, value))
              })
            })
          : pull.map(function (data) {
              return format(data.key, data.value, null)
            })
        )
      },
      close: close,
      destroy: destroy
      //put, del, batch - leave these out for now, since the indexes just map.
    }
  }
}
