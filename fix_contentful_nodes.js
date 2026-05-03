const axios = require('axios');
const fs = require('fs');

async function main() {
    const envContent = fs.readFileSync('/opt/nativpost/NativPost-seo/.env.local', 'utf8');
    const tokenMatch = envContent.match(/CONTENTFUL_CMA_TOKEN=([^\r\n]+)/);
    if (!tokenMatch) { console.error('Token not found'); process.exit(1); }
    const token = tokenMatch[1].trim();
    const space = 'sudko060ydqn';
    const base = 'https://api.contentful.com/spaces/' + space + '/environments/master';
    const headers = {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/vnd.contentful.management.v1+json'
    };

    try {
        const ct = await axios.get(base + '/content_types/pageBlogPost', { headers });
        const version = ct.data.sys.version;
        const fields = ct.data.fields;
        const contentField = fields.find(f => f.id === 'content');
        if (!contentField) { console.log('Content field not found'); return; }

        console.log('Localized:', contentField.localized);
        console.log('Validations:', JSON.stringify(contentField.validations, null, 2));

        const nodeTypeVal = (contentField.validations || []).find(v => v.enabledNodeTypes);
        if (nodeTypeVal) {
            console.log('Found enabledNodeTypes:', nodeTypeVal.enabledNodeTypes);
            if (!nodeTypeVal.enabledNodeTypes.includes('paragraph')) {
                nodeTypeVal.enabledNodeTypes.push('paragraph');
                console.log('Added paragraph. New list:', nodeTypeVal.enabledNodeTypes);
            } else {
                console.log('Paragraph already in list');
            }
        } else {
            console.log('No enabledNodeTypes restriction — all node types already allowed');
        }

        const ctData = { ...ct.data };
        delete ctData.sys;
        const updated = await axios.put(
            base + '/content_types/pageBlogPost',
            { ...ctData, fields },
            { headers: { ...headers, 'X-Contentful-Version': version } }
        );
        await axios.put(
            base + '/content_types/pageBlogPost/published',
            {},
            { headers: { ...headers, 'X-Contentful-Version': updated.data.sys.version } }
        );
        console.log('Done — content type updated and published');
    } catch (e) {
        console.error('Error:', e.response ? JSON.stringify(e.response.data, null, 2) : e.message);
    }
}

main();