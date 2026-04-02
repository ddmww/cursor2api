function detectPlatform(userAgent: string): string | undefined {
    const ua = userAgent.toLowerCase();
    if (ua.includes('windows')) return 'Windows';
    if (ua.includes('mac os x') || ua.includes('macintosh')) return 'macOS';
    if (ua.includes('android')) return 'Android';
    if (ua.includes('iphone') || ua.includes('ipad')) return 'iOS';
    if (ua.includes('linux')) return 'Linux';
    return undefined;
}

function detectPlatformVersion(platform: string | undefined): string | undefined {
    if (platform === 'Windows') return '19.0.0';
    return undefined;
}

function detectArch(userAgent: string): string | undefined {
    const ua = userAgent.toLowerCase();
    if (ua.includes('aarch64') || ua.includes('arm64') || ua.includes(' arm')) return 'arm';
    if (ua.includes('x86_64') || ua.includes('x64') || ua.includes('win64') || ua.includes('intel')) return 'x86';
    return undefined;
}

function extractMajorVersion(browser: string | undefined, userAgent: string): string | undefined {
    if (browser) {
        const match = browser.match(/(\d{2,3})/);
        if (match) return match[1];
    }

    for (const pattern of [/Edg\/(\d+)/, /Chrome\/(\d+)/, /Chromium\/(\d+)/, /Firefox\/(\d+)/, /Version\/(\d+)/]) {
        const match = userAgent.match(pattern);
        if (match) return match[1];
    }

    return undefined;
}

export function extractBrowserProfile(userAgent: string): string {
    if (!userAgent) return 'chrome140';

    const edge = userAgent.match(/Edg\/(\d+)/);
    if (edge) return `edge${edge[1]}`;

    const chromium = userAgent.match(/Chromium\/(\d+)/);
    if (chromium) return `chromium${chromium[1]}`;

    const chrome = userAgent.match(/Chrome\/(\d+)/);
    if (chrome) return `chrome${chrome[1]}`;

    const firefox = userAgent.match(/Firefox\/(\d+)/);
    if (firefox) return `firefox${firefox[1]}`;

    const safari = userAgent.match(/Version\/(\d+).+Safari\//);
    if (safari) return `safari${safari[1]}`;

    return 'chrome140';
}

export function buildClientHintHeaders(userAgent: string, browserHint?: string): Record<string, string> {
    const browser = (browserHint || extractBrowserProfile(userAgent)).trim().toLowerCase();
    const ua = userAgent.toLowerCase();
    const isEdge = browser.includes('edge') || ua.includes('edg/');
    const isBrave = browser.includes('brave');
    const isChromium =
        browser.includes('chrome') ||
        browser.includes('chromium') ||
        browser.includes('edge') ||
        browser.includes('brave') ||
        ua.includes('chrome/') ||
        ua.includes('chromium/') ||
        ua.includes('edg/');

    const isFirefox = browser.includes('firefox') || ua.includes('firefox/');
    const isSafari =
        (ua.includes('safari/') && !ua.includes('chrome/') && !ua.includes('chromium/') && !ua.includes('edg/')) ||
        browser.includes('safari');

    if (!isChromium || isFirefox || isSafari) {
        return {};
    }

    const version = extractMajorVersion(browser, userAgent);
    if (!version) return {};

    const brand = isEdge
        ? 'Microsoft Edge'
        : browser.includes('chromium')
            ? 'Chromium'
            : isBrave
                ? 'Brave'
                : 'Google Chrome';

    const platform = detectPlatform(userAgent);
    const arch = detectArch(userAgent);
    const mobile = ua.includes('mobile') || platform === 'Android' || platform === 'iOS' ? '?1' : '?0';

    const headers: Record<string, string> = {
        'sec-ch-ua': `"${brand}";v="${version}", "Chromium";v="${version}", "Not=A?Brand";v="24"`,
        'sec-ch-ua-mobile': mobile,
    };

    if (platform) headers['sec-ch-ua-platform'] = `"${platform}"`;
    const platformVersion = detectPlatformVersion(platform);
    if (platformVersion) headers['sec-ch-ua-platform-version'] = `"${platformVersion}"`;
    if (arch) {
        headers['sec-ch-ua-arch'] = `"${arch}"`;
        headers['sec-ch-ua-bitness'] = '"64"';
    }

    return headers;
}

export function getLegacyClientHintHeaders(): Record<string, string> {
    return {
        'sec-ch-ua-platform': '"Windows"',
        'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-arch': '"x86"',
        'sec-ch-ua-platform-version': '"19.0.0"',
    };
}
