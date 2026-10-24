import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat,readFile } from 'node:fs/promises';
import { validatePublicClient,buildPublicPayload,sendPublicPreview } from './public-client.mjs';

const CONFIG_DIR = fileURLToPath(new URL('../.runtime/',import.meta.url));
export const DEFAULT_COMMUNITY_CONFIG_PATH = path.join(CONFIG_DIR,'public-client-v2.json');
const CONFIG_KEYS = ['api_version','endpoint','expected_host','source_id','token'];
const FILENAME = /^public-client-v2(?:-[A-Za-z0-9_-]{1,48})?\.json$/;
const invalidConfig = () => new Error('v2个人专属上报配置字段、地址或密钥无效。');
const exact = (value,keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const transportClient = client => ({ endpoint:client.endpoint,expected_host:client.expected_host,source_id:client.source_id,token:client.token });

export function validateCommunityClient(config) {
  try {
    if (!exact(config,CONFIG_KEYS)) throw invalidConfig();
    const fixed = Object.fromEntries(CONFIG_KEYS.map(key => [key,config[key]]));
    if (fixed.api_version !== 2) throw invalidConfig();
    const base = validatePublicClient(transportClient(fixed));
    return Object.freeze({ api_version:2,...base });
  } catch { throw invalidConfig(); }
}
export async function loadCommunityClient(configPath = DEFAULT_COMMUNITY_CONFIG_PATH,{ read = readFile,stat = lstat } = {}) {
  if (typeof configPath !== 'string' || configPath.includes('\0')) throw new Error('v2个人专属配置位置无效。');
  // A bare safe filename is an alias inside this project's fixed runtime directory.
  const filename = path.basename(configPath) === configPath ? path.join(CONFIG_DIR,configPath) : path.resolve(configPath);
  if (path.dirname(filename) !== path.resolve(CONFIG_DIR) || !FILENAME.test(path.basename(filename))) {
    throw new Error('只允许读取本工程运行目录内的v2个人专属配置。');
  }
  let value;
  try {
    const directory = await stat(CONFIG_DIR), file = await stat(filename);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() ||
        !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 16384) throw new Error();
    const bytes = await read(filename);
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 16384) throw new Error();
    value = JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(bytes));
  } catch { throw new Error('v2个人专属配置无法读取，请先从个人中心下载配置。'); }
  return validateCommunityClient(value);
}
export function buildCommunityPayload(preview,config) {
  return buildPublicPayload(preview,transportClient(validateCommunityClient(config)));
}
export async function sendCommunityPreview(preview,config,{ request = https.request,...options } = {}) {
  const base = transportClient(validateCommunityClient(config));
  const original = new URL(base.endpoint+'/api/usage').href;
  const target = new URL(base.endpoint+'/api/v2/usage').href;
  return sendPublicPreview(preview,base,{ ...options,request(url,requestOptions,callback) {
    // The reused transport can request only this exact original target. It never sends to v1.
    if (!(url instanceof URL) || url.href !== original || typeof request !== 'function') {
      throw new Error('v2个人专属上报地址无效。');
    }
    return request(new URL(target),requestOptions,callback);
  } });
}
