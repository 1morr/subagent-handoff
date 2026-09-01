import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { runProbes } from '../src/probe.mjs'
import { defaultProvider } from '../src/config.mjs'
import { listen } from './helpers.mjs'

/** 起一個只服務這一項測試的假上游，handler 決定每一筆怎麼回，並記下收到的 body。 */
async function withUpstream(handler, fn) {
  const seen = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    seen.push(body)
    handler(body, res)
  })
  const url = await listen(server)
  try {
    return await fn(url, seen)
  } finally {
    server.close()
  }
}

function replyJson(res, payload) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

test('SSE 測試：上游最後一個事件沒有換行收尾也要算數', async () => {
  const LF = String.fromCharCode(10)
  await withUpstream(
    (_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: content_block_delta${LF}data: {}${LF}${LF}`)
      // 故意不以換行收尾：最後一行卡在 buffer 裡，漏收就會誤判成串流不完整
      res.end(`event: message_stop${LF}data: {}`)
    },
    async (url) => {
      const provider = defaultProvider({ baseUrl: url, model: 'm' })
      const [result] = (await runProbes(provider, { tests: ['streaming'] })).results
      assert.equal(result.ok, true, result.error)
      assert.match(result.detail, /message_stop/)
    },
  )
})

test('思考檔位：dropFields 含 output_config 時直接判失敗，不必打上游', async () => {
  await withUpstream(
    (_body, res) => replyJson(res, {}),
    async (url, seen) => {
      const provider = defaultProvider({ baseUrl: url, model: 'm', dropFields: ['output_config'] })
      const [result] = (await runProbes(provider, { tests: ['effort'] })).results
      assert.equal(result.ok, false)
      assert.match(result.error, /output_config/)
      assert.equal(seen.length, 0, '本地就能判定的事情不該浪費一次上游呼叫')
    },
  )
})

test('思考檔位：上游拒收任一檔位就判失敗，並把上游的錯誤訊息帶出來', async () => {
  await withUpstream(
    (body, res) => {
      if (body.output_config?.effort === 'xhigh') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'unknown variant `xhigh`' } }))
        return
      }
      replyJson(res, { content: [{ type: 'text', text: 'ok' }] })
    },
    async (url) => {
      const provider = defaultProvider({ baseUrl: url, model: 'm' })
      const [result] = (await runProbes(provider, { tests: ['effort'] })).results
      assert.equal(result.ok, false)
      assert.match(result.error, /xhigh/, '錯誤訊息要指得出是哪個檔位、為什麼')
      assert.match(result.detail, /4\/5/)
    },
  )
})

test('思考檔位：五檔全收時送出完整枚舉，而且只打五次', async () => {
  await withUpstream(
    (body, res) => replyJson(res, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    async (url, seen) => {
      const provider = defaultProvider({ baseUrl: url, model: 'm' })
      const [result] = (await runProbes(provider, { tests: ['effort'] })).results

      assert.equal(result.ok, true)
      assert.deepEqual(
        seen.map((b) => b.output_config.effort),
        ['low', 'medium', 'high', 'xhigh', 'max'],
        '要照 Claude Code 的枚舉逐一測，不能只挑兩端',
      )
      assert.equal(seen.length, 5, '量測那兩次已經拿掉了，付費 provider 上不該白花')
      // 探針要送真實的請求形狀，否則測不出上游對整包的寬容度
      assert.equal(seen[0].thinking.type, 'adaptive')
      assert.ok(seen[0].context_management, 'context_management 也要一起送')
    },
  )
})

test('runProbes：沒有 baseUrl 或沒有 model 名時，本地判失敗，不打任何上游', async () => {
  const noUrl = await runProbes(defaultProvider({ baseUrl: '', model: 'm' }))
  assert.equal(noUrl.results[0].ok, false)
  assert.match(noUrl.results[0].error, /Base URL/)

  const noModel = await runProbes(defaultProvider({ baseUrl: 'https://x.test', model: '' }))
  assert.equal(noModel.results[0].ok, false)
  assert.match(noModel.results[0].error, /model/)
})
