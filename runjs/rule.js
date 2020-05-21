const fs = require('fs')
const url = require('url')
const path = require('path')

const runJSFile = require('./runJSFile')
const { logger } = require('../utils')

const clog = new logger({head: 'anyRule'})

const config = {
  reqlists: [],
  reslists: [],
  rewritelists: [],
  uagent: {},
  adblockflag: false,
  glevel: 'info'
}

if (!fs.existsSync(path.join(__dirname, 'Lists'))) {
  fs.mkdirSync(path.join(__dirname, 'Lists'))
}

function getrules($request, $response, lists) {
  const $req = $request.requestOptions

  const urlObj = url.parse($request.url)
  let matchstr = {
    ip: urlObj.hostname,
    url: $request.url,
    host: urlObj.hostname,
    reqmethod: $req.method,
    reqbody: $request.requestData,
    useragent: $req.headers["User-Agent"],
    resstatus: $response?$response.statusCode:"",
    restype: $response?$response.header["Content-Type"]:"",
    resbody: $response?$response.body:""
  }
  return lists.filter(l=>{ return (new RegExp(l[1])).test(matchstr[l[0]]) })
}

function init(){
  if (fs.existsSync(path.join(__dirname, 'Lists', "useragent.list"))) {
    try {
      config.uagent = JSON.parse(fs.readFileSync(path.join(__dirname, 'Lists', "useragent.list"), "utf8"))
    } catch {
      config.uagent = {}
    }
  }

  config.rewritelists = []
  config.subrules = []
  if (fs.existsSync(path.join(__dirname, 'Lists', 'rewrite.list'))) {
    fs.readFileSync(path.join(__dirname, 'Lists', 'rewrite.list'), 'utf8').split(/\r|\n/).forEach(l=>{
      if (/^#/.test(l) || l.length<2) return
      let item = l.split(" ")
      if (item.length == 2) {
        if (/js$/.test(item[1])) {
          config.rewritelists.push([item[0], item[1]])
        } else if (/^sub/.test(item[0])) {
          config.subrules.push(item[1])
        }
      }
    })
  }

  config.reqlists = []
  config.reslists = []
  if (fs.existsSync(path.join(__dirname, 'Lists', 'default.list'))) {
    fs.readFileSync(path.join(__dirname, 'Lists', 'default.list'), 'utf8').split(/\n|\r/).forEach(l=>{
      if (l.length<=8 || /^#/.test(l)) return
      let item = l.split(",")
      if (item.length >= 4) {
        item = item.map(i=>i.trim())
        if (item[4] == "req") config.reqlists.push(item)
        else config.reslists.push(item)
      }
    })
  }

  if (fs.existsSync(path.join(__dirname, 'Lists', 'mitmhost.list'))) {
    config.host = fs.readFileSync(path.join(__dirname, 'Lists', 'mitmhost.list'), 'utf8').split(/\r|\n/).filter(host=>{
      if (/^(\[|#|;)/.test(host) || host.length < 3) {return false}
      return true
    })
  }

  clog.notify(`default 规则 ${ config.reqlists.length + config.reslists.length} 条`)
  clog.notify(`rewrite 规则 ${ config.rewritelists.length} 条`)
  clog.notify(`MITM hosts ${config.host.length} 个`)

  return config
}
init()

const localResponse = {
  reject: {
    statusCode: 200,
    header: { 'Content-Type': 'text/plain' },
    body: ''
  },
  imghtml: {
    statusCode: 200,
    header: { 'Content-Type': 'text/html; charset=utf-8' },
    body: '<img src="data:image/png;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="elecV2P"/>'
  },
  json: {
    statusCode: 200,
    header: { 'Content-Type': 'application/json' },
    body: '{"data": "elecV2P"}'
  },
  tinyimg: {
    statusCode: 200,
    header: { 'Content-Type': 'image/png' },
    body: Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')
  }
}

module.exports = {
  summary: 'elecV2P rule - customize personal network',
  init,
  config,
  *beforeSendRequest(requestDetail) {
    // console.log(requestDetail.requestOptions)
    const $request = requestDetail

    let getr = getrules(requestDetail, null, config.reqlists)
    if(getr.length) clog.info("reqlists:", getr.length)
    for(let r of getr) {
      if ("block" === r[2]) {
        clog.info("block - " + r[3])
        return { response: localResponse[r[3]] }
      }
      if (/^301$|^302$|^307$/.test(r[2])) {
        clog.info(r[2] + "重定向至 " + r[3])
        return {
          response: {
            statusCode: r[2],
            header: {Location: r[3]}
          }
        }
      }
      if ("ua" == r[2]) {
        const newreqOptions = requestDetail.requestOptions
        newreqOptions.headers['User-Agent'] = config.uagent[r[3]].header
        clog.info("User-Agent 设置为：" + r[3])
        return {
          requestOptions: newreqOptions
        }
      }
      // 通过 JS 文件修改请求体
      let jsres = runJSFile(r[3], { $request })
      if (jsres.response) {
        // 直接返回结果，不访问目标网址
        clog.notify('返回结果:', jsres.response)
        return { 
          response: Object.assign(localResponse.reject, jsres.response) 
        }
      }
      // 请求信息修改
      let newreqOptions = requestDetail.requestOptions
      if (jsres["User-Agent"]) {
        clog.info("User-Agent 设置为: " + jsres["User-Agent"])
        newreqOptions.headers["User-Agent"] = jsres["User-Agent"]
      } else if (jsres.body) {
        clog.info("body changed")
        requestDetail.requestData = jsres.body
      } else {
        Object.assign(newreqOptions, jsres)
        // newreqOptions = { newreqOptions, ...jsres }
      }
    }
    return requestDetail
  },
  *beforeSendResponse(requestDetail, responseDetail) {
    // clog.info(config.rewritelists.length)
    const $request = requestDetail
    const $response = responseDetail.response

    for (let r of config.rewritelists) {
      if ((new RegExp(r[0])).test($request.url)) {
        Object.assign($response, runJSFile(r[1], { $request, $response }))
        break
      }
    }

    let getr = getrules($request, $response, config.reslists)
    if(getr.length) clog.info("reslists:", getr.length)
    for(let r of getr) {
      if (r[2] == "js" || r[2] == 404) {
        Object.assign($response, runJSFile(r[3], {$request, $response}))
      }
    }

    return { response: $response }
  },
  *beforeDealHttpsRequest(requestDetail) {
    let host = requestDetail.host.split(":")[0]
    if (config.host.indexOf(host) !== -1) {
      // clog.info(host)
      return true
    }
    return false
  }
}