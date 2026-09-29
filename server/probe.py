"""Reader probe: connect to an Impinj reader and print reads with phase, Doppler, channel and RSSI.

    python probe.py 192.168.1.50                   # ports 1-3, 30 dBm, fixed channel 1, 50 reads
    python probe.py 192.168.1.50 --channels 1 2 3 4 --power 27 --count 200 --raw

Use it once per reader/firmware to confirm the Impinj extensions are reported. Stop CrossMgrImpinj
first (one LLRP client only).
"""
from __future__ import annotations

import argparse
import logging
import threading

from llrp_client import AntennaConfig, ReaderConfig, build_sllurp_config, parse_tag


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("host")
    ap.add_argument("--port", type=int, default=5084)
    ap.add_argument("--antennas", type=int, nargs="+", default=[1, 2, 3])
    ap.add_argument("--power", type=float, default=30.0)
    ap.add_argument("--channels", type=int, nargs="+", default=[1])
    ap.add_argument("--search-mode", default="dual", choices=["reader", "single", "dual", "single-ab"])
    ap.add_argument("--mode-index", type=int, default=1000)
    ap.add_argument("--count", type=int, default=50)
    ap.add_argument("--raw", action="store_true", help="also print the raw sllurp tag dict")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING)

    from sllurp.llrp import LLRPReaderClient, LLRPReaderConfig  # type: ignore

    cfg = ReaderConfig(antennas=[AntennaConfig(p, args.power) for p in args.antennas], rx_sens_dbm=-200,
                       search_mode=args.search_mode, mode_index=args.mode_index, channels=args.channels)
    done = threading.Event()
    seen = {"n": 0, "phase": 0, "doppler": 0, "hires": 0}

    def on_report(_reader, tags):
        for t in tags:
            r = parse_tag(t)
            if not r or done.is_set():
                continue
            seen["n"] += 1
            seen["phase"] += r["phase"] is not None
            seen["doppler"] += r["doppler"] is not None
            seen["hires"] += t.get("ImpinjPeakRSSI") is not None
            ph = f"{r['phase']:.3f}" if r["phase"] is not None else "  -  "
            dp = f"{r['doppler']:+.2f}" if r["doppler"] is not None else "  -  "
            print(f"{r['ts']} ant {r['port']} ch {r['channel']} rssi {r['rssi']:7.2f} phase {ph} doppler {dp}  {r['epc']}")
            if args.raw:
                print("   raw:", t)
            if seen["n"] >= args.count:
                done.set()

    client = LLRPReaderClient(args.host, args.port, LLRPReaderConfig(build_sllurp_config(cfg)))
    client.add_tag_report_callback(on_report)
    client.connect()
    try:
        done.wait(60)
    finally:
        client.disconnect()
        client.join(5)
    n = max(seen["n"], 1)
    print(f"\n{seen['n']} reads: phase in {seen['phase'] / n:.0%}, Doppler in {seen['doppler'] / n:.0%}, "
          f"high-res RSSI in {seen['hires'] / n:.0%}")
    if seen["n"] and not seen["phase"]:
        print("No phase angle reported: the reader/firmware may not support the Impinj extensions.")


if __name__ == "__main__":
    main()
