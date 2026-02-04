import json
import time
import sys
import os
import requests

url = "https://d1.weather.com.cn/satellite2015/JC_YT_DL_WXZXCSYT_4B.html?jsoncallback=readSatellite&callback=jQuery18208455971171376718_" + str(round(time.time() * 1000)) + "&_=" + str(round(time.time() * 1000))
headers = {
    "Referer": "http://www.weather.com.cn/satellite/",
    "User-Agent": "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/72.0.3626.109 Safari/537.36",
}

resp = requests.get(url, headers=headers, timeout=60, verify=False)
resp.raise_for_status()
data = resp.text
data = data[14:-1]
print(data)
j = json.loads(data.replace('\'','\"'))
for a in j['radars']:
    print(a['ft'])
    img_url = "https://pi.weather.com.cn/i/product/pic/l/sevp_nsmc_" + a['fn'] + "_lno_py_" + a['ft'] + ".jpg"
    out_dir = os.path.join(sys.path[0], "weather")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, a['ft'] + ".jpg")
    img_resp = requests.get(img_url, headers=headers, timeout=60, verify=False)
    img_resp.raise_for_status()
    with open(out_path, "wb") as f:
        f.write(img_resp.content)
