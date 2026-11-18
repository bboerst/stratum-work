# Timestamp

This is the timestamp for when the message was received from the pool.

With the Go collector (`collector-go/`) this is `templates.received_at`: the kernel's receive time of the network data that carried the
message, to the microsecond (the Python collector takes its own clock right after the read). How it's taken, the clocks
behind it and its limits: [How the data is measured](methodology.md#arrival-times).
