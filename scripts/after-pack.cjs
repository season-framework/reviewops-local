'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const asar=require('@electron/asar');

module.exports=async function afterPack({appOutDir,packager}){
  const resources=packager.getResourcesDir(appOutDir);
  // Copy the packaged canonical data after ASAR creation. Declaring this source
  // file in extraResources would exclude it from the app's relative requires.
  await fs.mkdir(path.join(resources,'mcp'),{recursive:true});
  for(const [source,target]of [['mcp-server.cjs','reviewops-mcp.cjs'],['automation-api.cjs','automation-api.cjs'],['review-categories.json','review-categories.json']]){
    const bytes=asar.extractFile(path.join(resources,'app.asar'),path.join('electron',source));
    await fs.writeFile(path.join(resources,'mcp',target),bytes);
  }
  // Standalone Node cannot read Electron's virtual ASAR paths. Publish the
  // canonical packaged bootstrap at the physical path injected by main.
  await fs.mkdir(path.join(resources,'owned-services'),{recursive:true});
  await fs.writeFile(path.join(resources,'owned-services','owned-node-bootstrap.cjs'),asar.extractFile(path.join(resources,'app.asar'),path.join('electron','owned-node-bootstrap.cjs')));
};
