import xml.etree.ElementTree as ET
import time
import sys
import os
import requests

url = 'http://img.nsmc.org.cn/PORTAL/NSMC/XML/FY4B/FY4B_AGRI_IMG_DISK_GCLR_NOM.xml'
headers = {
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6,zh-TW;q=0.5",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Origin": "http://nsmc.org.cn/",
    "Pragma": "no-cache",
    "Referer": "http://nsmc.org.cn/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0",
    "dnt": "1",
    "sec-gpc": "1",
}

resp = requests.get(url, headers=headers, timeout=60, verify=False)
resp.raise_for_status()
data = resp.text
print(data)
root = ET.fromstring(data)
out_dir = os.path.join(sys.path[0], "weather")
os.makedirs(out_dir, exist_ok=True)

for img in root.findall('.//image'):
    img_url = img.attrib.get('url')
    if not img_url:
        continue
    
    if img_url.startswith('//'):
        img_url = 'http:' + img_url
        
    filename = img_url.split('/')[-1]
    out_path = os.path.join(out_dir, filename)
    
    print(f"Downloading {filename}...")
    try:
        img_resp = requests.get(img_url, headers=headers, timeout=60, verify=False)
        img_resp.raise_for_status()
        with open(out_path, "wb") as f:
            f.write(img_resp.content)
    except Exception as e:
        print(f"Failed to download {filename}: {e}")
