function cygRFC(ws) {
  var self = this;
  this.ws = ws;
  self.remoteCallId = 0;
  self.remoteCallBack = 0;  
  self.MQTTonNewMsg = function (topic, data) {
    console.log("New message, topic: "+topic+" message: "+data);
  }
  self._onmessage = function (data) {
    var raw=data.data.trim();  
    if (typeof self.onmessage!="undefined") self.onmessage(raw);
    try {
      var jsdata = JSON.parse(raw);
      if (jsdata.protocol=="MQTT") {
        self.MQTTonNewMsg(jsdata.topic, jsdata.ret)
      } else if (jsdata.protocol=="RFC") {
        var o = JSON.parse(raw);
        if (o.id == self.remoteCallId) self.remoteCallBack(o.ret);
      }
    } catch (e) {

    }
  }

  this.ws.onmessage = self._onmessage;

  self.remoteCall = function (param, callBack) {
    if (typeof param.callType=="undefined") param.callType = "function";
    param.id=Math.round(Math.random()*100000);
    self.remoteCallId = param.id;
    self.remoteCallBack = callBack;
    self.ws.send(JSON.stringify(param));
    return 0;
  }
}

/****** call example ******/
// FC.remoteCall({"name": "abc", "params": [123,"aa"]},
//   function (data) {
//     console.log("reply: "+data);
//   }
// );