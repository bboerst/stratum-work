from typing import Any, Dict, List, Tuple


def extract_coinbase_data(block: Dict[str, Any]) -> Tuple[str, List[str]]:
    coinbase_tx = block["tx"][0]
    vin0 = coinbase_tx["vin"][0]
    if "scriptSig" in vin0 and "hex" in vin0["scriptSig"]:
        coinbase_script_sig = vin0["scriptSig"]["hex"]
    elif "coinbase" in vin0:
        coinbase_script_sig = vin0["coinbase"]
    else:
        raise KeyError("No coinbase script found")

    coinbase_addresses: List[str] = []
    for out in coinbase_tx["vout"]:
        script_pub_key = out.get("scriptPubKey", {})
        if "addresses" in script_pub_key:
            coinbase_addresses.extend(script_pub_key["addresses"])
        elif "address" in script_pub_key:
            coinbase_addresses.append(script_pub_key["address"])
        elif "desc" in script_pub_key and "address" in script_pub_key:
            coinbase_addresses.append(script_pub_key["address"])

    address_values: Dict[str, float] = {}
    for out in coinbase_tx["vout"]:
        script_pub_key = out.get("scriptPubKey", {})
        value = out.get("value", 0)
        addresses: List[str] = []
        if "addresses" in script_pub_key:
            addresses = script_pub_key["addresses"]
        elif "address" in script_pub_key:
            addresses = [script_pub_key["address"]]
        for addr in addresses:
            if addr in address_values:
                address_values[addr] += value
            else:
                address_values[addr] = value

    coinbase_addresses = sorted(
        coinbase_addresses,
        key=lambda addr: address_values.get(addr, 0),
        reverse=True
    )
    return coinbase_script_sig, coinbase_addresses


