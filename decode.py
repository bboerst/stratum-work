import json
import sys
from pycoin.symbols.btc import network
import requests
import string
import argparse
import ast

def hash_code(text):
    return sum(ord(char) for char in text)

def get_transaction_fee_rate(first_transaction):
    if first_transaction == 'empty block':
        return ''

    try:
        response = requests.get(f'https://mempool.space/api/tx/{first_transaction}')
        if response.status_code == 200:
            data = response.json()
            fee = data.get('fee')
            weight = data.get('weight')
            if fee is not None and weight is not None:
                return round(fee / (weight / 4))
        return 'not found'
    except requests.exceptions.RequestException:
        return 'Error'

def extract_coinbase_script_ascii(coinbase_tx):
    script_sig_hex = coinbase_tx.txs_in[0].script.hex()
    return ''.join(filter(lambda x: x in string.printable, bytes.fromhex(script_sig_hex).decode('ascii', 'replace')))

def process_mining_notify(notify_dict, extranonce1, extranonce2_length):
    params = notify_dict['params']
    
    coinbase1 = params[2]
    coinbase2 = params[3]
    prev_hash = params[1]
    version = params[5]
    merkle_branches = params[4]

    coinbase_hex = coinbase1 + extranonce1 + '00' * extranonce2_length + coinbase2
    coinbase_tx = network.Tx.from_hex(coinbase_hex)
    output_value = sum(tx_out.coin_value for tx_out in coinbase_tx.txs_out) / 1e8
    height = int.from_bytes(coinbase_tx.txs_in[0].script[1:4], byteorder='little')
    prev_block_hash = bytes.fromhex(prev_hash)[::-1].hex()
    block_version = int(version, 16)
    first_transaction = bytes(reversed(bytes.fromhex(merkle_branches[0]))).hex() if merkle_branches else 'empty block'
    fee_rate = get_transaction_fee_rate(first_transaction)
    script_sig_ascii = extract_coinbase_script_ascii(coinbase_tx)

    result = {
        'height': height,
        'prev_block_hash': prev_block_hash,
        'block_version': block_version,
        'coinbase_raw': coinbase_hex,
        'version': version,
        'nbits': params[6],
        'ntime': params[7],
        'coinbase_script_ascii': script_sig_ascii,
        'clean_jobs': params[8],
        'first_transaction': first_transaction,
        'fee_rate': fee_rate,
        'merkle_branches': merkle_branches,
        'coinbase_output_value': output_value
    }

    return json.dumps(result)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Process mining.notify message and output decoded fields")
    parser.add_argument("notify_dict", help="Python dictionary containing mining.notify message")
    parser.add_argument("extranonce1", help="Extranonce1 value")
    parser.add_argument("extranonce2_length", type=int, help="Extranonce2 length")
    
    args = parser.parse_args()

    # Parse the input string as a Python dictionary
    notify_dict = ast.literal_eval(args.notify_dict)

    result = process_mining_notify(notify_dict, args.extranonce1, args.extranonce2_length)
    print(result)