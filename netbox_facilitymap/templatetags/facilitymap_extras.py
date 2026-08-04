from django import template
from django.templatetags.static import static

register = template.Library()


@register.simple_tag(takes_context=True)
def static_versioned(context, path):
    """{% static %} + the plugin version as a `?v=` cache-buster (INSTALL-1), so a stale
    collectstatic/CDN copy of an eager script is invalidated the same way App.ensureScripts
    already invalidates the lazy editor/import bundles."""
    url = static(path)
    version = context.get('version')
    if not version:
        return url
    sep = '&' if '?' in url else '?'
    return f'{url}{sep}v={version}'
