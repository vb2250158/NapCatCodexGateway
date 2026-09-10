package com.rabi.link.protocol;

import org.junit.Test;
import static org.junit.Assert.*;

public class RabiGlassVideoProtocolTest {
    private static final String PATH = ":1936/rabi/0123456789abcdef0123456789abcdef";
    @Test public void acceptsPrivatePhoneNetworks() {
        for (String ip : new String[]{"10.0.0.1", "192.168.4.1", "172.16.2.1", "172.31.255.1"})
            assertTrue(RabiGlassVideoProtocol.isLocalReceiver("rtmp://" + ip + PATH));
    }
    @Test public void rejectsPublicHostsCredentialsAndMalformedTargets() {
        for (String ip : new String[]{"8.8.8.8", "127.0.0.1", "172.32.0.1", "10.0.0.999", "phone.example", "user@10.0.0.1"})
            assertFalse(RabiGlassVideoProtocol.isLocalReceiver("rtmp://" + ip + PATH));
        assertFalse(RabiGlassVideoProtocol.isLocalReceiver("rtmp://10.0.0.1" + PATH + "?target=other"));
        assertFalse(RabiGlassVideoProtocol.isLocalReceiver("rtmp://10.0.0.1:1936/rabi/wrong"));
        assertFalse(RabiGlassVideoProtocol.isLocalReceiver("rtmp://10.0.0.1:80/rabi/0123456789abcdef0123456789abcdef"));
    }
}
