"""Tiny Marionette client for driving a test Thunderbird instance."""
import json, socket, sys

class Marionette:
    def __init__(self, port=2829):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=120)
        self.buf = b""
        self.id = 0
        self._read()  # handshake
        self.cmd("WebDriver:NewSession", {"capabilities": {}})
        self.cmd("Marionette:SetContext", {"value": "chrome"})

    def _read(self):
        while b":" not in self.buf:
            self.buf += self.s.recv(65536)
        n, rest = self.buf.split(b":", 1)
        n = int(n)
        while len(rest) < n:
            rest += self.s.recv(65536)
        self.buf = rest[n:]
        return json.loads(rest[:n])

    def cmd(self, name, params=None):
        self.id += 1
        data = json.dumps([0, self.id, name, params or {}]).encode()
        self.s.sendall(str(len(data)).encode() + b":" + data)
        while True:
            msg = self._read()
            if msg[0] == 1 and msg[1] == self.id:
                if msg[2]:
                    raise RuntimeError(json.dumps(msg[2])[:2000])
                return msg[3]

    def js(self, script, *args):
        return self.cmd("WebDriver:ExecuteScript", {"script": "return (async () => {" + script + "\n})();", "args": list(args), "newSandbox": False, "scriptTimeout": 120000}).get("value")

if __name__ == "__main__":
    m = Marionette()
    print(json.dumps(m.js(sys.stdin.read()), indent=1))
