# Pool Work

"Pool Work" aims to log all "mining.notify" stratum messages incoming from a pool to a databse for historical logging purposes. I plan to run many of these concurrently in order to capture history of what work pools sent to miners to work on. In the future, queries can be developed to get an overview of work delegation historically. Additionally, a frontend can be developed to utilize the database for realtime data aggregation and visualization.

```
python main.py --help
usage: main.py [-h] -u URL -up USERPASS -p POOL_NAME [-d DB_URL] -dn DB_NAME -du DB_USERNAME -dp
               DB_PASSWORD [-l {DEBUG,INFO,WARNING,ERROR,CRITICAL}]

Subscribe to a Stratum endpoint and listen for new work

options:
  -h, --help            show this help message and exit
  -u URL, --url URL     The URL of the stratum server, including port. Ex:
                        stratum+tcp://beststratumpool.com:3333
  -up USERPASS, --userpass USERPASS
                        Username and password combination separated by a colon (:)
  -p POOL_NAME, --pool-name POOL_NAME
                        The name of the pool
  -d DB_URL, --db-url DB_URL
                        The URL of the MongoDB database (default: mongodb://localhost:27017)
  -dn DB_NAME, --db-name DB_NAME
                        The name of the MongoDB database
  -du DB_USERNAME, --db-username DB_USERNAME
                        The username for MongoDB authentication
  -dp DB_PASSWORD, --db-password DB_PASSWORD
                        The password for MongoDB authentication
  -l {DEBUG,INFO,WARNING,ERROR,CRITICAL}, --log-level {DEBUG,INFO,WARNING,ERROR,CRITICAL}
                        Set the logging level (default: INFO)
```
