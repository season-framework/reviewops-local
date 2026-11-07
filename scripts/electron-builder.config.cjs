'use strict';
const path=require('node:path');
const {builderConfiguration}=require('./mac-signing.cjs');
module.exports=builderConfiguration(require('../package.json').build,process.env,path.resolve(__dirname,'..'));
