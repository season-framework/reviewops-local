// Old test packages have only a global build number. Do not invent a per-version
// development number for them when rendering their identity.
export function displayBuildVersion(build, fallback = '—') {
 const version=build?.version||fallback;
 if(build?.channel!=='test')return version;
 if(Number.isSafeInteger(build.developmentNumber)&&build.developmentNumber>0)return `${version}-dev-${build.developmentNumber}`;
 return Number.isSafeInteger(build.buildNumber)&&build.buildNumber>0?`${version}-test.${build.buildNumber}`:version;
}
