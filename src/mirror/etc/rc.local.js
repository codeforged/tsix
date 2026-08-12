var d=Object.defineProperty;var o=Object.getOwnPropertyDescriptor;var l=Object.getOwnPropertyNames;var p=Object.prototype.hasOwnProperty;var m=(a,t)=>{for(var r in t)d(a,r,{get:t[r],enumerable:!0})},u=(a,t,r,n)=>{if(t&&typeof t=="object"||typeof t=="function")for(let s of l(t))!p.call(a,s)&&s!==r&&d(a,s,{get:()=>t[s],enumerable:!(n=o(t,s))||n.enumerable});return a};var $=a=>u(d({},"__esModule",{value:!0}),a);var f={};m(f,{default:()=>c});module.exports=$(f);class c{async execute(t,r){const n="\x1B[92m",s="\x1B[97m",i=`${n}[  ${n}OK${n}  ]\x1B[0m `;await t.std.print(`${i} [rc.local] Starting system daemons...
`);try{const e=await t.shell.exec("/sbin/airtermd.ts",[],void 0,void 0,void 0);e&&await t.std.print(`${i} [rc.local] Airterm daemon started (PID ${e.pid}).
`)}catch(e){await t.std.print(`[rc.local] Warning: Failed to start airtermd: ${e.message}
`)}try{const e=await t.shell.exec("/sbin/tpkgd.ts",[],void 0,void 0,void 0);e&&await t.std.print(`${i} [rc.local] TPKG Repository Daemon started (PID ${e.pid}).
`)}catch(e){await t.std.print(`[rc.local] Warning: Failed to start tpkgd: ${e.message}
`)}try{const e=await t.shell.exec("/sbin/scpd.ts",[],void 0,void 0,void 0);e&&await t.std.print(`${i} [rc.local] SCP Daemon started (PID ${e.pid}).
`)}catch(e){await t.std.print(`[rc.local] Warning: Failed to start scpd: ${e.message}
`)}return await t.std.print(`${i} [rc.local] All startup services initialized.
`),await t.shell.exit(0),""}}
