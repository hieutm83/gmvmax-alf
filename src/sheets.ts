import type { Env } from './types';

function base64Url(value: Uint8Array | string): string {
  const text = typeof value === 'string' ? value : String.fromCharCode(...value);
  return btoa(text).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function googleToken(env: Env): Promise<string> {
  if(!env.GOOGLE_SERVICE_ACCOUNT_EMAIL||!env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)throw new Error('Google backup is not configured.');
  const now=Math.floor(Date.now()/1000);const header=base64Url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const claim=base64Url(JSON.stringify({iss:env.GOOGLE_SERVICE_ACCOUNT_EMAIL,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
  const pem=env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g,'\n').replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(pem),c=>c.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const unsigned=`${header}.${claim}`;const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(unsigned));
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:`grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${unsigned}.${base64Url(new Uint8Array(signature))}`});
  const data=await response.json<any>();if(!response.ok)throw new Error(data.error_description||data.error);return data.access_token;
}

export async function backupDate(env: Env, reportDate: string): Promise<void> {
  if(!env.GOOGLE_BACKUP_SPREADSHEET_ID)return;
  const rows=await env.DB.prepare('SELECT summary_json,products_json,creatives_json FROM daily_metrics WHERE report_date=?').bind(reportDate).all<any>();
  if(!rows.results.length)return;const token=await googleToken(env);const values=rows.results.map(row=>[reportDate,row.summary_json||'',row.products_json||'',row.creatives_json||'']);
  const range=encodeURIComponent('GMV_MAX_BACKUP!A:D');const url=`https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_BACKUP_SPREADSHEET_ID}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values})});
  if(!response.ok)throw new Error(`Google Sheets backup HTTP ${response.status}: ${(await response.text()).slice(0,300)}`);
}
