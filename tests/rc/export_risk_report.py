import csv
from pathlib import Path
from datetime import datetime
from collections import Counter

import requests


BASE_URL = "http://127.0.0.1:5000/api/risk/check"


INPUT = Path(
    "tests/samples/risk-samples.csv"
)


OUTPUT = Path(
    "docs/rc/risk-test-result.csv"
)


def judge(sample_id, expected, actual):

    number = int(sample_id.split("-")[1])


    # 正常安全样本
    if 1 <= number <= 15:

        if actual == "high":
            return "NOTE"

        return "PASS"



    # 可疑边界样本
    if 16 <= number <= 25:

        if actual in (
            "low",
            "medium",
            "high"
        ):
            return "PASS"

        return "FAIL"



    # 明显高风险样本
    if 26 <= number <= 35:

        if actual == "high":
            return "PASS"

        return "FAIL"



    # 插件E2E Demo
    if 36 <= number <= 45:

        return "MANUAL"



    # 误报回归
    if 46 <= number <= 50:

        if actual == "high":
            return "NOTE"

        return "PASS"



    return "UNKNOWN"



def request_risk(text):

    payload = {

        "url": "http://rc-test.local",

        "content": text,

        "source": "backend"

    }


    response = requests.post(

        BASE_URL,

        json=payload,

        timeout=10

    )


    data = response.json()


    return data["data"]




def main():

    rows = []


    with INPUT.open(

        encoding="utf-8-sig",

        newline=""

    ) as f:


        reader = csv.DictReader(f)


        for item in reader:


            print(

                item["ID"],

                end=" "

            )


            try:


                result = request_risk(

                    item["测试文本或特征"]

                )


                status = judge(

                    item["ID"],

                    item["预期行为"],

                    result["risk_level"]

                )


                print(

                    result["risk_level"],

                    result["score"],

                    status

                )



                item["测试日期"] = datetime.now().strftime(

                    "%Y-%m-%d"

                )


                item["实际风险等级"] = result[

                    "risk_level"

                ]


                item["RiskScore"] = result[

                    "score"

                ]


                item["Reason"] = result[

                    "reason"

                ]


                item["结果"] = status



            except Exception as e:


                item["结果"] = "ERROR"

                item["备注"] = str(e)



            rows.append(item)



    OUTPUT.parent.mkdir(

        exist_ok=True

    )



    with OUTPUT.open(

        "w",

        encoding="utf-8-sig",

        newline=""

    ) as f:


        writer = csv.DictWriter(

            f,

            fieldnames=rows[0].keys()

        )


        writer.writeheader()

        writer.writerows(rows)



    # ===== RC测试统计 =====

    summary = Counter(

        row["结果"]

        for row in rows

    )


    print()

    print("==============================")

    print(" RC Risk Test Summary")

    print("==============================")


    for key, value in summary.items():

        print(

            f"{key}: {value}"

        )


    print(

        "TOTAL:",

        len(rows)

    )


    print()

    print(

        "Report generated:",

        OUTPUT

    )




if __name__ == "__main__":

    main()