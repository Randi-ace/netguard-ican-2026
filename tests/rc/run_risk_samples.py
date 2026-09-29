import csv
import requests
from pathlib import Path


CSV_PATH = Path(
    "tests/samples/risk-samples.csv"
)

API_URL = (
    "http://127.0.0.1:5000/api/risk/check"
)


with CSV_PATH.open(
    "r",
    encoding="utf-8-sig",
    newline=""
) as f:
    rows = list(csv.DictReader(f))


for row in rows:

    if row["测试入口"] != "API_DIRECT":
        continue

    payload = {
        "url": row["URL或页面"] or "http://test.com",
        "content": row["测试文本或特征"],
        "source": "backend"
    }

    try:
        response = requests.post(
            API_URL,
            json=payload,
            timeout=5
        )

        data = response.json()

        result = data.get("data", {})

        print(
            row["ID"],
            result.get("risk_level"),
            result.get("score"),
            result.get("reason")
        )

    except Exception as e:
        print(
            row["ID"],
            "ERROR",
            e
        )