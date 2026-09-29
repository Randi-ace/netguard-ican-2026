import logging

from flask import Blueprint, jsonify, request

from services.event_service import (
    EventPersistenceError,
    EventValidationError,
    event_service,
)


logger = logging.getLogger(__name__)
events_bp = Blueprint('events', __name__, url_prefix='/api/events')


def _event_response(result):
    if result['duplicate']:
        return jsonify({
            'code': 1,
            'message': 'duplicate',
            'data': result['data'],
        }), 200

    return jsonify({
        'code': 0,
        'message': 'success',
        'data': result['data'],
    }), 201


def _error_response(message, http_status):
    return jsonify({
        'code': http_status,
        'message': message,
        'data': None,
    }), http_status


@events_bp.route('/risk', methods=['POST'])
def create_risk_event():
    try:
        result = event_service.create_risk_event(
            request.get_json(silent=True)
        )
        return _event_response(result)
    except EventValidationError as exc:
        return _error_response(str(exc), 400)
    except EventPersistenceError as exc:
        return _error_response(str(exc), 503)
    except Exception:
        logger.exception('风险事件接口发生未预期异常')
        return _error_response('风险事件服务暂时不可用', 500)


@events_bp.route('/ad', methods=['POST'])
def create_ad_event():
    try:
        result = event_service.create_ad_event(
            request.get_json(silent=True)
        )
        return _event_response(result)
    except EventValidationError as exc:
        return _error_response(str(exc), 400)
    except EventPersistenceError as exc:
        return _error_response(str(exc), 503)
    except Exception:
        logger.exception('广告事件接口发生未预期异常')
        return _error_response('广告事件服务暂时不可用', 500)
