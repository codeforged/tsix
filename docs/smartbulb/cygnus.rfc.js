function cygRFC(ws) {
  var self = this;
  this.ws = ws;
  self.remoteCallId = 0;
  self.remoteCallBack = 0;  
  self.onmessage = function (data) {
    var raw=data.data.trim();
    var o = JSON.parse(raw);
    if (o.id == self.remoteCallId) self.remoteCallBack(o.ret);
  }

  this.ws.onmessage = self.onmessage;

  self.remoteCall = function (param, callBack) {
    if (typeof param.callType=="undefined") param.callType = "function";
    param.id=Math.round(Math.random()*100000);
    self.remoteCallId = param.id;
    self.remoteCallBack = callBack;
    self.ws.send(JSON.stringify(param));
  }
}