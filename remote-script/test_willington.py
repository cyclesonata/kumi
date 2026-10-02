import hashlib
import unittest
from test_remote_script import FakeSong, FakeClip, _protect_windows_owner_only
from ableton_mcp_remote_script import LiveObjectMapper, validate_operation_payload

class FollowClip(FakeClip):
    def __init__(self):
        super().__init__(4)
        self.is_playing = self.is_triggered = self.is_recording = False
        self.follow_action_enabled = False
        self.follow_action_linked = True
        self.follow_action_a = 4
        self.follow_action_b = 0
        self.follow_action_loop_count = 1
        self.follow_action_time = 4.0
        self.follow_action_jump_a = self.follow_action_jump_b = 1.0
        self.follow_action_chance_a = 100
    @property
    def follow_action_chance_a(self): return self._chance
    @follow_action_chance_a.setter
    def follow_action_chance_a(self, value): self._chance = float(value)
    @property
    def follow_action_chance_b(self): return 100 - self._chance

class WillingtonTests(unittest.TestCase):
    def setUp(self):
        self.song = FakeSong(); self.clip = FollowClip()
        self.song.tracks[0].clip_slots[0].clip = self.clip
        self.mapper = LiveObjectMapper(self.song)
        self.mapper.willington_follow_writes = True
        self.row = self.mapper.snapshot()['tracks'][0]['clips'][0]
    def args(self, **changes):
        before = self.mapper._follow_action_fields(self.clip)
        return {**before, **changes, 'ref': self.row['ref'], 'expectedObjectIdentity': self.row['objectIdentity'],
                'expectedAuthorityRevision': self.mapper._clip_authority_digest(self.row['ref']),
                'expectedStateRevision': hashlib.sha256(self.mapper._bounded_canonical(before).encode()).hexdigest()}
    def test_follow_capability_is_available_before_the_first_clip_exists(self):
        self.song.tracks[0].clip_slots[0].clip = None
        self.assertTrue(self.mapper._operation_supported('clip.follow-actions.set'))
        self.song.tracks[0].clip_slots[0].clip = FakeClip(4)
        self.row = self.mapper.snapshot()['tracks'][0]['clips'][0]
        self.assertTrue(self.mapper._operation_supported('clip.follow-actions.set'))
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            self.mapper._follow_action_set(self.args())
        self.mapper.willington_follow_writes = False
        self.assertFalse(self.mapper._operation_supported('clip.follow-actions.set'))

    def test_follow_read_write_and_explicit_restoration(self):
        self.assertTrue(self.mapper._operation_supported('clip.follow-actions.set'))
        prior = self.mapper._follow_action_fields(self.clip)
        args = self.args(followActionChanceA=75, followActionChanceB=25, followActionEnabled=True)
        validate_operation_payload('clip.follow-actions.set', 'request', args)
        result = self.mapper.invoke('clip.follow-actions.set', args)
        validate_operation_payload('clip.follow-actions.set', 'result', result)
        self.assertEqual(self.clip.follow_action_chance_b, 25)
        self.mapper.invoke('clip.follow-actions.set', self.args(**prior))
        self.assertEqual(self.mapper._follow_action_fields(self.clip), prior)
    def test_refuse_disabled_stale_playing_and_invalid(self):
        self.mapper.willington_follow_writes = False
        self.assertFalse(self.mapper._operation_supported('clip.follow-actions.set'))
        with self.assertRaises(ValueError): self.mapper._follow_action_set(self.args())
        self.mapper.willington_follow_writes = True
        stale = self.args(); self.clip.follow_action_a = 5
        with self.assertRaisesRegex(ValueError, 'state changed'): self.mapper._follow_action_set(stale)
        for values in ({'followActionChanceA': 75}, {'followActionA': True}, {'followActionJumpA': 0}, {'followActionLoopCount': 1.5}):
            with self.assertRaises(ValueError): self.mapper._follow_action_set(self.args(**values))
        self.song.is_playing = True
        with self.assertRaisesRegex(ValueError, 'stopped'): self.mapper._follow_action_set(self.args())
    def test_stopped_transport_allows_retained_session_flags_but_not_recording(self):
        for attribute in ('is_playing', 'is_triggered'):
            setattr(self.clip, attribute, True)
            prior = self.mapper._follow_action_fields(self.clip)
            self.mapper._follow_action_set(self.args(followActionA=8))
            self.mapper._follow_action_set(self.args(**prior))
            self.assertTrue(getattr(self.clip, attribute))
            setattr(self.clip, attribute, False)
        self.clip.is_recording = True
        with self.assertRaisesRegex(ValueError, 'non-recording clip'):
            self.mapper._follow_action_set(self.args(followActionA=8))
        self.clip.is_recording = False
        prepared = self.args(followActionA=8)
        self.song.is_playing = True
        with self.assertRaisesRegex(ValueError, 'stopped transport'):
            self.mapper._follow_action_set(prepared)
        self.assertEqual(self.clip.follow_action_a, 4)

    def test_partial_write_restores_all_fields(self):
        prior = self.mapper._follow_action_fields(self.clip)
        original = self.clip.__class__
        class FailingClip(original):
            fail = True
            def __setattr__(self, key, value):
                if key == 'follow_action_loop_count' and value == 2 and self.fail:
                    self.fail = False
                    raise RuntimeError('injected')
                super().__setattr__(key, value)
        self.clip.__class__ = FailingClip
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            self.mapper._follow_action_set(self.args(followActionA=7, followActionLoopCount=2))
        self.assertEqual(self.mapper._follow_action_fields(self.clip), prior)

class ZoneTests(unittest.TestCase):
    def setUp(self):
        DeviceTests.setUp(self)
        import json
        self.rack.class_name = 'InstrumentGroupDevice'
        self.chain = self.rack.chains[0]
        self.zone = {'minimum':12, 'maximum':104, 'fadeMinimum':24, 'fadeMaximum':88,
                     'lowerBound':0, 'upperBound':127}
        self.chain.get_zone = lambda kind: json.dumps(self.zone)
        def write(kind, minimum, maximum, fade_minimum, fade_maximum):
            self.zone.update(minimum=minimum, maximum=maximum,
                             fadeMinimum=fade_minimum, fadeMaximum=fade_maximum)
        self.chain.set_zone = write
        self.mapper.willington_zone_writes = True
        self.row = self.mapper.snapshot()['tracks'][0]['devices'][0]
        self.selector = {'ref':self.row['ref'], 'kind':'selector-zone',
                         'targetRef':self.row['chains'][0]['ref']}

    def test_audio_racks_refuse_hidden_key_and_velocity_zones(self):
        self.rack.class_name = 'AudioEffectGroupDevice'
        for kind in ['key-zone', 'velocity-zone']:
            with self.assertRaisesRegex(ValueError, 'selector zones only'):
                self.mapper._willington_device_read({**self.selector, 'kind': kind})
        self.mapper._willington_device_read(self.selector)

    def test_zone_complete_state_and_restore(self):
        before = self.mapper.invoke('willington.device.read', self.selector)
        next_state = {'minimum':16, 'maximum':40, 'fadeMinimum':20, 'fadeMaximum':36}
        args = {**self.selector, 'next':next_state, 'expectedStateRevision':before['stateRevision']}
        validate_operation_payload('willington.device.set', 'request', args)
        after = self.mapper.invoke('willington.device.set', args)
        validate_operation_payload('willington.device.set', 'result', after)
        self.assertEqual({key:after['state'][key] for key in next_state}, next_state)
        restored = self.mapper.invoke('willington.device.set', {**self.selector,
            'next':{key:before['state'][key] for key in next_state},
            'expectedStateRevision':after['stateRevision']})
        self.assertEqual(restored['stateRevision'], before['stateRevision'])

    def test_zone_refuses_stale_detached_disabled_and_bad_endpoints(self):
        before = self.mapper.invoke('willington.device.read', self.selector)
        args = {**self.selector, 'next':{'minimum':16,'maximum':40,'fadeMinimum':20,'fadeMaximum':36},
                'expectedStateRevision':before['stateRevision']}
        self.zone['fadeMaximum'] = 86
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.mapper.invoke('willington.device.set', args)
        self.mapper.willington_zone_writes = False
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            self.mapper.invoke('willington.device.read', self.selector)
        self.mapper.willington_zone_writes = True
        current = self.mapper.invoke('willington.device.read', self.selector)
        for value in (True, 20.5, -1, 50):
            bad = {**args, 'expectedStateRevision':current['stateRevision'],
                   'next':{**args['next'],'fadeMinimum':value}}
            with self.assertRaises(ValueError): self.mapper.invoke('willington.device.set', bad)
        self.rack.chains = []
        with self.assertRaisesRegex(ValueError, 'no longer'):
            self.mapper.invoke('willington.device.read', self.selector)

    def test_zone_partial_failure_restores_four_endpoints(self):
        before = dict(self.zone); write = self.chain.set_zone; fail = [True]
        def partial(kind, *values):
            if fail[0]:
                fail[0] = False
                self.zone['minimum'] = values[0]
                raise RuntimeError('injected zone failure')
            write(kind, *values)
        self.chain.set_zone = partial
        current = self.mapper.invoke('willington.device.read', self.selector)
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            self.mapper.invoke('willington.device.set', {**self.selector,
                'next':{'minimum':16,'maximum':40,'fadeMinimum':20,'fadeMaximum':36},
                'expectedStateRevision':current['stateRevision']})
        self.assertEqual(self.zone, before)

class DeviceTests(unittest.TestCase):
    def setUp(self):
        import json
        from test_remote_script import FakeRackDevice, FakeDevice
        self.song = FakeSong(); self.rack = FakeRackDevice(); self.target = FakeDevice()
        self.rack.chains = [type('Chain', (), {'name':'Chain', 'devices':[self.target], 'mute':False, 'solo':False})()]
        self.song.tracks[0].devices = [self.rack]
        self.mapper = LiveObjectMapper(self.song); self.mapper.willington_device_writes = True
        self.mapping = None; self.name = 'Variation 1'
        self.rack.rename_macro = lambda index, name: setattr(self.rack.macros[index], 'name', name)
        self.rack.get_selected_variation_name = lambda: self.name
        self.rack.rename_selected_variation = lambda name: setattr(self, 'name', name)
        self.rack.get_macro_mapping = lambda target: json.dumps(self.mapping)
        self.rack.map_macro = lambda index, target: setattr(self, 'mapping', {'index':index,'minimum':0.,'maximum':1.,'kind':'continuous'})
        self.rack.set_macro_mapping_range = lambda target, low, high: self.mapping.update(minimum=low,maximum=high)
        self.rack.unmap_macro = lambda target: setattr(self, 'mapping', None)
        self.row = self.mapper.snapshot()['tracks'][0]['devices'][0]
        self.ref = self.row['ref']; self.target_ref = self.row['chains'][0]['devices'][0]['parameters'][0]['ref']
    def selector(self, kind):
        return {'ref':self.ref,'kind':kind, **({'macroIndex':0} if kind=='macro-name' else {'targetRef':self.target_ref} if kind=='macro-mapping' else {})}
    def apply(self, kind, next):
        selector = self.selector(kind)
        before = self.mapper.invoke('willington.device.read', selector)
        args = {**selector,'next':next,'expectedStateRevision':before['stateRevision']}
        validate_operation_payload('willington.device.set','request',args)
        result = self.mapper.invoke('willington.device.set',args)
        validate_operation_payload('willington.device.set','result',result)
        return before,result
    def test_chain_mixer_discovery_is_bounded_and_rejects_detached_parent(self):
        from test_remote_script import FakeMixerDevice
        mixer = FakeMixerDevice(); mixer.panning.name = 'Chain Pan'; mixer.panning.min = -1
        self.rack.chains[0].mixer_device = mixer
        chain = self.mapper.snapshot()['tracks'][0]['devices'][0]['chains'][0]
        page = self.mapper.discover('parameter', parent=chain['ref'], limit=2)
        self.assertTrue(page['truncated'])
        rows = self.mapper.discover('parameter', parent=chain['ref'])['items']
        pan = next(row for row in rows if row['name']=='Chain Pan')
        self.assertEqual(pan['ref'],chain['mixer']['panningRef'])
        self.assertEqual((pan['min'],pan['max'],pan['parentRef']),(-1,1,chain['ref']))
        self.rack.chains = []
        with self.assertRaisesRegex(ValueError,'no longer authoritative'):
            self.mapper.discover('parameter', parent=chain['ref'])

    def test_names_apply_and_restore(self):
        for kind in ['macro-name','variation-name']:
            before,after = self.apply(kind, {'name':'Kumi 測試'})
            self.assertEqual(after['state']['name'],'Kumi 測試')
            _, restored = self.apply(kind, {'name':before['state']['name']})
            self.assertEqual(restored['stateRevision'],before['stateRevision'])
    def test_mapping_apply_and_restore(self):
        before,after = self.apply('macro-mapping', {'mapping':{'index':0,'minimum':0.75,'maximum':0.25,'kind':'continuous'},'parameterValue':0.5})
        self.assertEqual(self.mapping['minimum'],0.75)
        _,restored = self.apply('macro-mapping', {'mapping':None,'parameterValue':before['state']['parameterValue']})
        self.assertEqual(restored['stateRevision'], before['stateRevision'])
    def test_mapping_failure_compensates(self):
        self.rack.set_macro_mapping_range = lambda *args: (_ for _ in ()).throw(RuntimeError('injected'))
        with self.assertRaisesRegex(RuntimeError,'injected'):
            self.apply('macro-mapping', {'mapping':{'index':0,'minimum':0.75,'maximum':0.25,'kind':'continuous'},'parameterValue':0.5})
        self.assertIsNone(self.mapping)
    def test_stale_detached_invalid_and_playing(self):
        selector = self.selector('macro-name'); before = self.mapper.invoke('willington.device.read',selector)
        self.rack.macros[0].name = 'External edit'
        with self.assertRaisesRegex(ValueError,'changed'):
            self.mapper.invoke('willington.device.set',{**selector,'next':{'name':'New'},'expectedStateRevision':before['stateRevision']})
        with self.assertRaisesRegex(ValueError,'selector'):
            self.mapper.invoke('willington.device.read',{**selector,'targetRef':self.target_ref})
        self.song.is_playing = True
        with self.assertRaisesRegex(ValueError,'stopped'): self.apply('macro-name', {'name':'New'})
        self.song.is_playing = False; self.rack.chains[0].devices = []
        with self.assertRaisesRegex(ValueError,'no longer'): self.apply('macro-mapping',{'mapping':None,'parameterValue':0.5})

    def test_variation_rename_requires_restorable_selected_name(self):
        for selected, count, name in [(-1, 1, 'Name'), (0, 0, 'Name'), (0, 1, None), (0, 1, '')]:
            self.rack.selected_variation_index = selected
            self.rack.variation_count = count
            self.name = name
            with self.assertRaisesRegex(ValueError, 'variation must be selected'):
                self.mapper._willington_device_read({'ref': self.ref, 'kind': 'variation-name'})

class ProviderTests(unittest.TestCase):
    def test_absent_invalid_and_duplicate_owner_fail_closed(self):
        import tempfile, json, types
        from pathlib import Path
        from unittest.mock import patch
        import AbletonMcpBridge as wrapper
        with tempfile.TemporaryDirectory() as folder:
            mapper=types.SimpleNamespace(); logs=[]; live=types.SimpleNamespace(_kumi_willington_owner=object())
            with patch.object(wrapper,'__file__',str(Path(folder)/'__init__.py')), patch.dict('sys.modules',{'Live':live}):
                wrapper._WillingtonProvider(mapper,logs.append)
                self.assertFalse(mapper.willington_follow_writes)
                path=Path(folder)/'willington.json';path.write_text('{}');path.chmod(0o600)
                wrapper._WillingtonProvider(mapper,logs.append)
                self.assertFalse(mapper.willington_device_writes)
                path.write_text(json.dumps({'version':1,'followActions':False,'deviceTools':False,'enableWrites':False}))
                owner=live._kumi_willington_owner
                wrapper._WillingtonProvider(mapper,logs.append)
                self.assertIs(live._kumi_willington_owner,owner)
                self.assertEqual(len(logs),2)
    def test_missing_follow_self_test_preserves_independent_device_writes(self):
        import tempfile, json, types
        from pathlib import Path
        from unittest.mock import patch
        import AbletonMcpBridge as wrapper
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'willington.json'
            path.write_text(json.dumps({'version': 1, 'followActions': True, 'deviceTools': True, 'enableWrites': True})); path.chmod(0o600); _protect_windows_owner_only(path)
            mapper = types.SimpleNamespace(); live = types.SimpleNamespace(); logs = []; calls = []
            follow = types.SimpleNamespace(willington_enable_writes=lambda value: calls.append(('follow', value)))
            devices = types.SimpleNamespace(enable=lambda value: calls.append(('devices', value)), uninstall=lambda: None)
            modules = {'Live': live, 'WillingtonBindings': types.SimpleNamespace(__file__=str(Path(folder)/'bindings.py'), install=lambda: follow), 'WillingtonDeviceTools.api': types.SimpleNamespace(install=lambda: devices)}
            with patch.object(wrapper, '__file__', str(path.with_name('__init__.py'))), patch.dict('sys.modules', modules):
                provider = wrapper._WillingtonProvider(mapper, logs.append)
                self.assertFalse(mapper.willington_follow_writes)
                self.assertTrue(mapper.willington_device_writes)
                self.assertTrue(any('self-test.json' in line for line in logs))
                provider.close()

    def test_follow_evidence_uses_selected_profile_library(self):
        import tempfile, json, types
        from pathlib import Path
        from unittest.mock import patch
        import AbletonMcpBridge as wrapper
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = root / 'willington.json'
            config.write_text(json.dumps({'version': 1, 'followActions': True, 'deviceTools': False, 'enableWrites': True}))
            config.chmod(0o600); _protect_windows_owner_only(config)
            library = root / 'build' / 'selected-profile' / 'libwillington.dylib'
            library.parent.mkdir(parents=True)
            library.write_bytes(b'selected native library')
            # A stale root library must not be used for the evidence check.
            (root / 'libwillington.dylib').write_bytes(b'previous version')
            receipt = root / 'self-test.json'
            calls = []
            follow = types.SimpleNamespace(path=str(library), willington_enable_writes=calls.append)
            for payload, expected in [(library.read_bytes(), True), (b'previous version', False)]:
                receipt.write_text(json.dumps({'status': 'passed', 'library_sha256': hashlib.sha256(payload).hexdigest()}))
                live = types.SimpleNamespace(); mapper = types.SimpleNamespace()
                modules = {'Live': live, 'WillingtonBindings': types.SimpleNamespace(__file__=str(root / 'bindings.py'), install=lambda: follow)}
                with patch.object(wrapper, '__file__', str(root / '__init__.py')), patch.dict('sys.modules', modules):
                    provider = wrapper._WillingtonProvider(mapper, None)
                    self.assertEqual(mapper.willington_follow_writes, expected)
                    provider.close()

    def test_device_owner_enable_and_teardown(self):
        import tempfile,json,types
        from pathlib import Path
        from unittest.mock import patch
        import AbletonMcpBridge as wrapper
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'willington.json';path.write_text(json.dumps({'version':1,'followActions':False,'deviceTools':True,'enableWrites':True}));path.chmod(0o600);_protect_windows_owner_only(path)
            calls=[];native=types.SimpleNamespace(enable=lambda enabled:calls.append(enabled),uninstall=lambda:calls.append('uninstall'))
            live=types.SimpleNamespace();mapper=types.SimpleNamespace()
            with patch.object(wrapper,'__file__',str(path.with_name('__init__.py'))),patch.dict('sys.modules',{'Live':live,'WillingtonDeviceTools':types.ModuleType('WillingtonDeviceTools'),'WillingtonDeviceTools.api':types.SimpleNamespace(install=lambda:native)}):
                provider=wrapper._WillingtonProvider(mapper,None)
                self.assertTrue(mapper.willington_device_writes)
                self.assertIs(live._kumi_willington_owner,provider)
                provider.close();provider.close()
                self.assertEqual(calls,[True,'uninstall'])
                self.assertFalse(mapper.willington_device_writes)
                self.assertIsNone(live._kumi_willington_owner)


class ReviewRegressions(unittest.TestCase):
    def test_follow_time_uses_float32_readback(self):
        from test_remote_script import float32
        class RoundedClip(FollowClip):
            def __setattr__(self, name, value):
                super().__setattr__(name, float32(value) if name == 'follow_action_time' else value)
        test = WillingtonTests(); test.setUp()
        test.clip.__class__ = RoundedClip
        test.mapper._follow_action_set(test.args(followActionTime=1.333))
        self.assertEqual(test.clip.follow_action_time, float32(1.333))

    def test_follow_reads_only_for_enabled_session_clips(self):
        from unittest.mock import patch
        song = FakeSong(); clip = FollowClip()
        song.tracks[0].clip_slots[0].clip = clip
        song.tracks[0].arrangement_clips = [clip]
        mapper = LiveObjectMapper(song)
        with patch.object(mapper, '_follow_action_fields', side_effect=AssertionError('unexpected Follow reads')):
            snapshot = mapper.snapshot()
            self.assertNotIn('followActionA', snapshot['tracks'][0]['clips'][0])
        mapper.willington_follow_writes = True
        with patch.object(mapper, '_follow_action_fields', wraps=mapper._follow_action_fields) as read:
            snapshot = mapper.snapshot()
            self.assertEqual(read.call_count, 0)
            self.assertNotIn('followActionA', snapshot['tracks'][0]['clips'][0])
            row = snapshot['tracks'][0]['clips'][0]
            page = mapper.discover('session_clip', parent=row['ref'].replace(':clip:', ':clip_slot:'), requested_fields=['ref', 'followActionA'])
            self.assertEqual(page['items'][0]['followActionA'], 4)
            self.assertEqual(read.call_count, 1)
            self.assertNotIn('followActionA', snapshot['arrangement']['clips'][0])

    def test_macro_refs_are_canonical_and_readable(self):
        from test_remote_script import FakeRackDevice, FakeParameter
        song = FakeSong(); rack = FakeRackDevice()
        macros = [FakeParameter() for _ in range(16)]
        rack.parameters = [FakeParameter()] + macros
        del rack.macros
        rack.macros_mapped = [False] * 16
        song.tracks[0].devices = [rack]
        mapper = LiveObjectMapper(song)
        row = mapper.snapshot()['tracks'][0]['devices'][0]
        self.assertEqual([m['ref'] for m in row['macros']], [p['ref'] for p in row['parameters'][1:]])
        for macro in row['macros']:
            self.assertEqual(mapper.get(macro['ref'])['objectIdentity'], macro['objectIdentity'])
        authority = mapper._realtime_parameter_authority(row['macros'][0]['ref'])
        self.assertEqual(len({p['objectIdentity'] for p in authority['siblings']}), len(authority['siblings']))

    def test_mapping_rounding_remap_and_rollback_without_full_set_reads(self):
        from test_remote_script import float32
        from unittest.mock import patch
        import json
        test = DeviceTests(); test.setUp()
        parameter = test.target.parameters[0]; parameter.max = 20000
        test.rack.set_macro_mapping_range = lambda target, low, high: test.mapping.update(minimum=float32(low), maximum=float32(high))
        original_map = test.rack.map_macro
        def map_once(index, target):
            if test.mapping is not None: raise AssertionError('must unmap before remapping')
            original_map(index, target)
        test.rack.map_macro = map_once
        with patch.object(test.mapper, 'snapshot', side_effect=AssertionError('full snapshot forbidden')):
            test.apply('macro-mapping', {'mapping': {'index': 0, 'minimum': 2500.7, 'maximum': 12000.3, 'kind': 'continuous'}, 'parameterValue': 0.5})
            old = dict(test.mapping)
            test.apply('macro-mapping', {'mapping': {'index': 0, 'minimum': 2000.2, 'maximum': 10000.1, 'kind': 'continuous'}, 'parameterValue': 0.5})
            prior = dict(test.mapping)
            original_range = test.rack.set_macro_mapping_range
            def fail_new(target, low, high):
                if low == 3000.4: raise RuntimeError('injected range failure')
                original_range(target, low, high)
            test.rack.set_macro_mapping_range = fail_new
            with self.assertRaisesRegex(RuntimeError, 'injected range failure'):
                test.apply('macro-mapping', {'mapping': {'index': 0, 'minimum': 3000.4, 'maximum': 9000.1, 'kind': 'continuous'}, 'parameterValue': 0.5})
            self.assertEqual(test.mapping, prior)
            test.apply('macro-mapping', {'mapping': None, 'parameterValue': 2500.7})
            self.assertIsNone(test.mapping)

    def test_follow_provider_reconnect_reuses_disabled_native_registration(self):
        import tempfile, json, types
        from pathlib import Path
        from unittest.mock import patch
        import AbletonMcpBridge as wrapper
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'willington.json'
            path.write_text(json.dumps({'version': 1, 'followActions': True, 'deviceTools': False, 'enableWrites': False})); path.chmod(0o600); _protect_windows_owner_only(path)
            calls = []; live = types.SimpleNamespace(); mapper = types.SimpleNamespace()
            native = types.SimpleNamespace(willington_enable_writes=lambda value: calls.append(value))
            with patch.object(wrapper, '__file__', str(path.with_name('__init__.py'))), patch.dict('sys.modules', {'Live': live, 'WillingtonBindings': types.SimpleNamespace(install=lambda: (calls.append('install'), native)[1])}):
                first = wrapper._WillingtonProvider(mapper, None)
                first.close(); first.close()
                second = wrapper._WillingtonProvider(mapper, None)
                self.assertIs(second.follow, native)
                second.close()
            self.assertEqual(calls.count('install'), 1)
            self.assertFalse(mapper.willington_follow_writes)
            self.assertIsNone(live._kumi_willington_owner)
            self.assertIs(live._kumi_willington_follow_library, native)
