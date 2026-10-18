import {useSyncExternalStore} from 'react';
import en from './en.json' with {type:'json'};
import translations from './translations.json' with {type:'json'};

export const LANGUAGES = [
 {code:'en',name:'English',english:'English'},
 {code:'ko',name:'한국어',english:'Korean'},
 {code:'ja',name:'日本語',english:'Japanese'},
 {code:'zh-CN',name:'简体中文',english:'Chinese (Simplified)'},
 {code:'zh-TW',name:'繁體中文',english:'Chinese (Traditional)'},
 {code:'es',name:'Español',english:'Spanish'},
 {code:'fr',name:'Français',english:'French'},
 {code:'de',name:'Deutsch',english:'German'},
 {code:'pt-BR',name:'Português (Brasil)',english:'Portuguese (Brazil)'},
 {code:'it',name:'Italiano',english:'Italian'},
 {code:'ru',name:'Русский',english:'Russian'},
 {code:'vi',name:'Tiếng Việt',english:'Vietnamese'}
];
export const LANGUAGE_STORAGE_KEY = 'reviewops.language';
export function resolveLocale(value) {
 const raw=String(value||'').replace(/_/g,'-');
 const exact=LANGUAGES.find(item=>item.code.toLowerCase()===raw.toLowerCase());
 if(exact)return exact.code;
 if(/^zh-(?:TW|HK|MO|Hant)(?:-|$)/i.test(raw))return 'zh-TW';
 if(/^zh(?:-|$)/i.test(raw))return 'zh-CN';
 if(/^pt(?:-|$)/i.test(raw))return 'pt-BR';
 return LANGUAGES.find(item=>item.code===raw.split('-')[0].toLowerCase())?.code||'en';
}
function initialLocale() {
 try {const stored=globalThis.window?.localStorage?.getItem(LANGUAGE_STORAGE_KEY);if(stored)return resolveLocale(stored);
 // Existing installations keep their established language until a selection is made.
 if(globalThis.window?.localStorage?.getItem('reviewops.workspace.tabs'))return 'ko';}catch{}
 return resolveLocale(globalThis.navigator?.language||'en');
}
let locale=initialLocale();
try{globalThis.window?.localStorage?.setItem(LANGUAGE_STORAGE_KEY,locale)}catch{}
const listeners=new Set();
export const getLocale=()=>locale;
export const subscribeLocale=listener=>{listeners.add(listener);return()=>listeners.delete(listener)};
function syncNativeLanguage(language) {
 const bridge=globalThis.window?.reviewops;
 if(!bridge)return;
 try{Promise.resolve(bridge.request?bridge.request('app.language',{language}):bridge.invoke?.('app.language',{language})).catch(()=>{});}catch{}
}
export function setLocale(value) {
 const next=resolveLocale(value);
 try{globalThis.window?.localStorage?.setItem(LANGUAGE_STORAGE_KEY,next)}catch{}
 if(typeof document!=='undefined'){document.documentElement.lang=next;document.documentElement.dir='ltr';}
 syncNativeLanguage(next);
 if(next===locale)return;
 locale=next;listeners.forEach(listener=>listener());
}
export const useLocale=()=>useSyncExternalStore(subscribeLocale,getLocale,getLocale);
if(typeof document!=='undefined')document.documentElement.lang=locale;
syncNativeLanguage(locale);
if(typeof window!=='undefined')window.addEventListener('storage',event=>{if(event.key===LANGUAGE_STORAGE_KEY)setLocale(event.newValue)});

/** Only source messages use this function. User content must be rendered directly. */
export function t(message,values,language=locale) {
 if(typeof message!=='string')return message;
 const text=language==='ko'?message:translations[language]?.[message]??en[message]??message;
 if(!values)return text;
 return text.replace(/\{(\d+)\}/g,(placeholder,index)=>values[index]===undefined?placeholder:String(values[index]));
}
/** Static option catalogs read their labels in the current language, without altering values. */
const localizedCache=new WeakMap();
export function localized(value) {
 if(!value||typeof value!=='object')return typeof value==='string'?t(value):value;
 if(localizedCache.has(value))return localizedCache.get(value);
 const proxy=new Proxy(value,{get(target,key,receiver){const item=Reflect.get(target,key,receiver);return typeof item==='string'?t(item):item&&typeof item==='object'?localized(item):item;}});
 localizedCache.set(value,proxy);return proxy;
}
export function formatDate(value,options={}) {
 if(!value)return '—';
 const parsed=new Date(value);
 return Number.isNaN(parsed.valueOf())?'—':parsed.toLocaleString(locale,options);
}
export function localeCoverage(language) {
 if(language==='ko')return {translated:Object.keys(en).length,total:Object.keys(en).length};
 return {translated:language==='en'?Object.keys(en).length:Object.keys(translations[language]||{}).length,total:Object.keys(en).length};
}
