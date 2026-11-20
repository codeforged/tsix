var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
__export(stdin_exports, {
  IProgram: () => import_IProgram.IProgram,
  NetSocket: () => import_NetworkLib2.NetSocket,
  NetworkLib: () => import_NetworkLib2.NetworkLib,
  OSContext: () => import_IProgram.OSContext,
  Program: () => Program,
  RsaChaSocket: () => import_NetworkLib2.RsaChaSocket,
  db: () => db,
  fs: () => fs,
  keyboard: () => keyboard,
  net: () => net,
  os: () => os,
  shell: () => shell,
  std: () => std
});
module.exports = __toCommonJS(stdin_exports);
var import_IProgram = require("./IProgram");
var import_NetworkLib2 = require("./NetworkLib");
var import_RandomLib = require("./RandomLib");
const getLib = () => {
  const lib = global._tsixLib;
  if (!lib)
    throw new Error("TSIX Framework Error: UserLib not found in this thread!");
  return lib;
};
const std = new Proxy({}, {
  get: (_, prop) => {
    const val = getLib().std[prop];
    return typeof val === "function" ? val.bind(getLib().std) : val;
  }
});
const fs = new Proxy({}, {
  get: (_, prop) => {
    const val = getLib().fs[prop];
    return typeof val === "function" ? val.bind(getLib().fs) : val;
  }
});
const shell = new Proxy({}, {
  get: (_, prop) => {
    const val = getLib().shell[prop];
    return typeof val === "function" ? val.bind(getLib().shell) : val;
  }
});
const net = new Proxy({}, {
  get: (_, prop) => {
    const val = getLib().net[prop];
    return typeof val === "function" ? val.bind(getLib().net) : val;
  }
});
const db = new Proxy({}, {
  get: (_, prop) => {
    const val = getLib().db[prop];
    return typeof val === "function" ? val.bind(getLib().db) : val;
  }
});
const keyboard = new Proxy({}, {
  get: (_, prop) => {
    const val = getLib().keyboard[prop];
    return typeof val === "function" ? val.bind(getLib().keyboard) : val;
  }
});
const os = {
  get pid() {
    return getLib().getPid();
  },
  get rand() {
    return new import_RandomLib.RandomLib(
      global._tsixOsc || { std, fs, shell, aux: {} }
    );
  }
};
function Program(fn) {
  return class {
    async execute(os2, args) {
      global._tsixOsc = os2;
      try {
        return await fn(args);
      } catch (error) {
        try {
          const { std: std2 } = os2;
          if (std2 && typeof std2.error === "function") {
            const appName = args[0] || global.__filename || "app";
            await std2.error(
              error.stack || error.message || String(error),
              appName
            );
          }
        } catch (_) {
        }
        throw error;
      }
    }
  };
}
